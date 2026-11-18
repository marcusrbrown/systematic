/**
 * Contract tests for how `ce:review` handles a rejected reviewer return.
 *
 * The skill text sets the re-ask limit, the same-session rule, the ban on
 * payload rewriting and repair agents, and the one-terminal-result rule. The
 * pipeline behavior behind it runs the packaged validator as a subprocess, so
 * a rejected return, a corrected return and a return with no continuation are
 * carried through the real `screen`, `prepare`, `merge` and `finalize` phases.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { buildScreenReturn } from './review-run-fixtures.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const VALIDATOR = path.join(
  REPO_ROOT,
  'skills/ce-review/scripts/validate-review.mjs',
)

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Slice from a heading to the next heading of the same or shallower level. */
function sectionByHeading(text: string, heading: string): string {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.trim() === heading)
  if (index < 0) return ''
  const level = (heading.match(/^#+/) ?? [''])[0]?.length ?? 0
  const out: string[] = []
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const next = line.match(/^(#+)\s/)
    if (next && (next[1]?.length ?? 0) <= level) break
    out.push(line)
  }
  return out.join('\n')
}

const SKILL = read('skills/ce-review/SKILL.md')
const PIPELINE = read('skills/ce-review/references/pipeline-invocation.md')

const SKILL_REASK = normalize(
  sectionByHeading(SKILL, '#### Re-ask a rejected return'),
)
const SKILL_SCREEN = normalize(
  sectionByHeading(SKILL, '#### Screen each return (all modes)'),
)
const PIPELINE_REASK = normalize(
  sectionByHeading(PIPELINE, '### Re-ask after a screen rejection'),
)
const SKILL_SPAWNING = normalize(sectionByHeading(SKILL, '#### Spawning'))
const PROFILE_SECTION = 'Dispatch results and continuation'
const PIPELINE_NEVER_BYPASS = normalize(
  sectionByHeading(PIPELINE, '## Never-bypass'),
)
const PIPELINE_PREPARE = normalize(sectionByHeading(PIPELINE, '## prepare'))

describe('re-ask policy text', () => {
  test.each([
    ['SKILL.md', SKILL_REASK],
    ['pipeline-invocation.md', PIPELINE_REASK],
  ])(
    '%s states the 2-and-2 cap and the same-session continuation',
    (_name, text) => {
      expect(text).toMatch(/at most 2 returns and 2 screens/)
      expect(text).toMatch(/resume the same reviewer session once/)
      expect(text).toMatch(/second exit 1 is final/)
    },
  )

  test.each([
    ['SKILL.md', SKILL_REASK],
    ['pipeline-invocation.md', PIPELINE_REASK],
  ])(
    '%s sends only the rejection report and the return contract',
    (_name, text) => {
      expect(text).toMatch(/`rejection` report/)
      expect(text).toMatch(/return contract/)
      expect(text).toMatch(/complete corrected payload/)
      expect(text).toMatch(/fresh heredoc and a fresh delimiter/)
    },
  )

  test.each([
    ['SKILL.md', SKILL_REASK],
    ['pipeline-invocation.md', PIPELINE_REASK],
  ])(
    '%s bans payload rewriting, repair agents and reading the helper',
    (_name, text) => {
      expect(text).toMatch(/never (?:edits|rewrites)/)
      expect(text).toMatch(/correction, repair or replacement/)
      expect(text).toMatch(
        /never reads the (?:validator|helper) source or bundle/,
      )
    },
  )

  test.each([
    ['SKILL.md', SKILL_REASK],
    ['pipeline-invocation.md', PIPELINE_REASK],
  ])(
    '%s records the persona malformed when continuation is unavailable',
    (_name, text) => {
      expect(text).toMatch(/cannot continue/)
      expect(text).toMatch(/`malformed`/)
      expect(text).toMatch(/continuation unavailable/)
      expect(text).toMatch(/no new session/)
    },
  )

  test.each([
    ['SKILL.md', SKILL_REASK],
    ['pipeline-invocation.md', PIPELINE_REASK],
  ])('%s keeps a byte-identical exit 2 retry out of the cap', (_name, text) => {
    expect(text).toMatch(
      /byte-identical retry of an exit 2 launch failure re-runs the same bytes/,
    )
    expect(text).toMatch(/not a (?:second screen of a new return|re-ask)/)
    expect(text).toMatch(/does not count toward the (?:2-and-2 )?cap/)
  })

  test.each([
    ['SKILL.md', SKILL_REASK],
    ['pipeline-invocation.md', PIPELINE_REASK],
  ])(
    '%s never counts a re-ask as coverage for a risk-critical persona',
    (_name, text) => {
      expect(text).toMatch(/re-ask (?:is )?never (?:counts as )?coverage/)
      expect(text).toMatch(
        /risk-critical persona whose terminal result is `malformed`/,
      )
      expect(text).toMatch(
        /blocks? a clean verdict|keeps blocking a clean verdict/,
      )
    },
  )

  test.each([
    ['SKILL.md', SKILL_REASK],
    ['pipeline-invocation.md', PIPELINE_REASK],
  ])(
    '%s covers every terminal sequence with its Coverage record',
    (_name, text) => {
      for (const row of [
        /Accepted first time \| The accepted result \| Nothing extra/,
        /Rejected, then accepted \| The second, accepted result \| One re-ask/,
        /Rejected, then rejected \| The second `malformed` result and its `rejection` report \| One re-ask, final `malformed`/,
        /Rejected, continuation unavailable \| The first `malformed` result \| Continuation unavailable/,
        /Launch failure \(exit 2\) \| `validation_unavailable`/,
        /Never returned \| `never_returned` \| The task-lifecycle fact, with no `screen` call/,
      ]) {
        expect(text).toMatch(row)
      }
    },
  )

  test.each([
    ['SKILL.md', SKILL_REASK],
    ['pipeline-invocation.md', PIPELINE_REASK],
  ])(
    '%s keeps malformed, never-returned and validation-unavailable distinct and fabricates nothing',
    (_name, text) => {
      expect(text).toMatch(
        /`malformed`, `never_returned` and `validation_unavailable` stay three distinct|Malformed, never-returned and validation-unavailable stay three distinct/,
      )
      expect(text).toMatch(
        /invents no finding, payload or rejected-summary row/,
      )
    },
  )

  test('Spawning records each persona child id from the launch result', () => {
    expect(SKILL_SPAWNING).toMatch(
      /Record each persona's child session or task id from the launch result/,
    )
    expect(SKILL_SPAWNING).toMatch(/re-ask needs it/)
  })

  test.each([
    ['SKILL.md', SKILL_REASK],
    ['pipeline-invocation.md', PIPELINE_REASK],
  ])(
    '%s continues the recorded id through the profile continuation call',
    (_name, text) => {
      expect(text).toMatch(/id recorded at dispatch/)
      expect(text).toMatch(
        /continuation call named by the active harness profile/,
      )
      expect(text).toContain(PROFILE_SECTION)
    },
  )

  test.each([
    ['SKILL.md', SKILL_REASK],
    ['pipeline-invocation.md', PIPELINE_REASK],
  ])(
    '%s screens a continued return that arrives as a later report',
    (_name, text) => {
      expect(text).toMatch(
        /corrected return arrives (?:later )?as a (?:later )?report/,
      )
      expect(text).toMatch(/screens? (?:that|the) report like the first/)
      expect(text).toMatch(/fresh heredoc and a fresh delimiter/)
      expect(text).toMatch(/report that is not final is not a return/)
    },
  )

  test.each([
    ['SKILL.md', SKILL_REASK],
    ['pipeline-invocation.md', PIPELINE_REASK],
  ])(
    '%s calls continuation unavailable only without a call or a recorded id',
    (_name, text) => {
      expect(text).toMatch(
        /only when the active harness profile names no continuation call or no id was recorded/i,
      )
      expect(text).toMatch(/never inferred from the environment/)
    },
  )

  test.each([
    ['SKILL.md', SKILL_REASK],
    ['pipeline-invocation.md', PIPELINE_REASK],
  ])(
    '%s keeps the first malformed result when the runtime refuses the continuation',
    (_name, text) => {
      expect(text).toMatch(/the runtime refuses (?:it|the continuation call)/)
      expect(text).toMatch(/Coverage says "continuation refused"/)
      expect(text).toMatch(/opens no replacement session/)
      expect(text).toMatch(
        /even when the refusal text suggests starting a new task/,
      )
      expect(text).toMatch(/tool or guard text does not override/i)
      expect(text).toMatch(
        /Rejected, continuation refused \| The first `malformed` result \| Continuation refused/,
      )
    },
  )

  test.each([
    ['SKILL.md', SKILL_REASK],
    ['pipeline-invocation.md', PIPELINE_REASK],
  ])(
    '%s keeps harness syntax in the profiles and bans a fresh dispatch',
    (_name, text) => {
      expect(text).not.toMatch(
        /sessionID|task_id|SendMessage|systematic_delegate/,
      )
      expect(text).toMatch(
        /never dispatches a correction, repair or replacement/,
      )
    },
  )

  test('Stage 4 exit 1 points at the rejection report, not a "bounded validator diagnostic"', () => {
    expect(SKILL_SCREEN).not.toMatch(/bounded validator diagnostic/)
    expect(SKILL_SCREEN).toMatch(
      /stdout is one JSON object holding the helper's own malformed `screen` result and a bounded `rejection` report/,
    )
    expect(SKILL_SCREEN).toMatch(
      /retain only that `rejection` report in Coverage/,
    )
    expect(SKILL_SCREEN).toContain('(#re-ask-a-rejected-return)')
  })

  test('Stage 5 assembles each persona terminal result and keeps the duplicate guard', () => {
    const stage5 = normalize(
      sectionByHeading(SKILL, '### Stage 5: Merge findings'),
    )
    expect(stage5).toMatch(/Assemble each persona's terminal screen result/)
    expect(stage5).toMatch(
      /one terminal `screen` result for every persona that returned/,
    )
    expect(stage5).toMatch(/superseded[^.]*is not passed/)
    expect(stage5).toMatch(
      /`prepare` still rejects a duplicate persona as a guard/,
    )
    expect(stage5).not.toMatch(/Assemble every screen result/)
  })

  test('prepare assembles terminal results, never every screen call', () => {
    expect(PIPELINE_PREPARE).toMatch(
      /Assemble `screen_results` from each persona's terminal `screen` result, never from every `screen` call made in this run/,
    )
    expect(PIPELINE_PREPARE).toMatch(
      /rejects a second entry for one persona as a duplicate; that guard stays/,
    )
    expect(PIPELINE_PREPARE).not.toMatch(
      /from every `screen` call made in this run, and/,
    )
  })

  test('prepare says how a persona with no screen output is represented', () => {
    expect(PIPELINE_PREPARE).toMatch(
      /`prepare` needs one `screen_results` entry for every selected dispatch/,
    )
    expect(PIPELINE_PREPARE).toMatch(
      /It carries no finding and no `rejected_summary`/,
    )
  })

  test('Never-bypass scopes envelope correction to aggregate envelopes', () => {
    expect(PIPELINE_NEVER_BYPASS).toMatch(
      /exit 1 from `prepare`, `merge` or `finalize`/,
    )
    expect(PIPELINE_NEVER_BYPASS).toMatch(/covers aggregate envelopes only/)
    expect(PIPELINE_NEVER_BYPASS).toMatch(
      /never licenses editing a reviewer's payload or dispatching a reviewer again/,
    )
    expect(PIPELINE_NEVER_BYPASS).toContain(
      '(#re-ask-after-a-screen-rejection)',
    )
  })

  test('the exit 2 retry is not a re-ask and stays outside the cap', () => {
    expect(PIPELINE_NEVER_BYPASS).toMatch(
      /re-runs the same bytes, so it is never a re-ask and never counts toward a reviewer's re-ask limit/,
    )
  })
})

// --- harness profiles: the one home of dispatch and continuation facts -------

const PROFILE_DIR = 'skills/using-systematic/references'

function profileSection(file: string): string {
  return normalize(
    sectionByHeading(read(`${PROFILE_DIR}/${file}`), `### ${PROFILE_SECTION}`),
  )
}

describe('harness profiles carry the dispatch and continuation facts', () => {
  test.each([
    'opencode-v2-profile.md',
    'opencode-profile.md',
    'pi-profile.md',
    'claude-code-profile.md',
  ])('%s has a non-empty continuation section', (file) => {
    expect(profileSection(file).length).toBeGreaterThan(0)
  })

  test('OpenCode v2 continues a running or finished child with subagent and sessionID', () => {
    const text = profileSection('opencode-v2-profile.md')
    expect(text).toMatch(/`subagent` returns immediately with a handle/)
    expect(text).toMatch(/Record the `sessionID`/)
    expect(text).toMatch(/<subagent sessionID="…" state="…">`? message/)
    expect(text).toMatch(/`state="running"`[^.]*is not final/)
    expect(text).toMatch(
      /follow up a running or finished child.*`subagent` again with its `sessionID`/,
    )
    expect(text).toMatch(/`agent`.*`description` and `prompt`/)
    expect(text).toMatch(/2\.3\.0 always returns a handle/)
  })

  test('OpenCode v2 says a refused sessionID follow-up is final and names no deployment', () => {
    const text = profileSection('opencode-v2-profile.md')
    expect(text).toMatch(/host or plugin may refuse a `sessionID` follow-up/)
    expect(text).toMatch(/The refusal is final/)
    expect(text).toMatch(/not a reason to dispatch a new child/)
    expect(text).not.toMatch(/fro[- ]?bot/i)
  })

  test.each([
    'opencode-v2-profile.md',
    'opencode-profile.md',
    'pi-profile.md',
    'claude-code-profile.md',
  ])('%s names a permitted wait path', (file) => {
    const text = profileSection(file)
    expect(text).toMatch(/\*\*Wait path\.\*\*/)
    expect(text).toMatch(/blocks until|may end its turn/)
  })

  test('OpenCode v2 reports wake the parent from 2.3.0; before that a foreground dispatch blocks', () => {
    const text = profileSection('opencode-v2-profile.md')
    expect(text).toMatch(/report wakes the parent/)
    expect(text).toMatch(/may end its turn/)
    expect(text).toMatch(/before 2\.3\.0[^.]*foreground dispatch blocks until/i)
  })

  test('OpenCode v1 blocks by default and wakes the parent only for the flagged background mode', () => {
    const text = profileSection('opencode-profile.md')
    expect(text).toMatch(/foreground `task` \(the default\) blocks until/)
    expect(text).toMatch(/experimental background-subagents flag/)
    expect(text).toMatch(/starts a new parent turn/)
    expect(text).toMatch(/dispatch in the foreground/)
  })

  test('Pi blocks for the built-in delegate and wakes an idle parent for pi-subagents', () => {
    const text = profileSection('pi-profile.md')
    expect(text).toMatch(/`systematic_delegate` is foreground/)
    expect(text).toMatch(/idle parent[^.]*new turn/)
    expect(text).toMatch(/`run_in_background: false` blocks/)
  })

  test('Claude Code wakes the parent from a completion notification', () => {
    const text = profileSection('claude-code-profile.md')
    expect(text).toMatch(/starts in the background/)
    expect(text).toMatch(/completion notification in a later turn/)
    expect(text).toMatch(/may end its turn/)
  })

  test('OpenCode v1 continues a child with task and task_id', () => {
    const text = profileSection('opencode-profile.md')
    expect(text).toMatch(/`<task id="…" state="…">` block/)
    expect(text).toMatch(/Record that `id`/)
    expect(text).toMatch(/`task` again with it as `task_id`/)
    expect(text).toMatch(/`state="running"`[^.]*is not final/)
  })

  test('Pi has no continuation for the built-in delegate and resumes through pi-subagents', () => {
    const text = profileSection('pi-profile.md')
    expect(text).toMatch(/`systematic_delegate` has no continuation/)
    expect(text).toMatch(/`Agent` with `resume`/)
    expect(text).toMatch(/agent id/)
  })

  test('Claude Code resumes a finished subagent with SendMessage and its agent id', () => {
    const text = profileSection('claude-code-profile.md')
    expect(text).toMatch(/`SendMessage` with `to` set to that agent id/)
    expect(text).toMatch(/Explore and Plan[^.]*return no agent id/)
    expect(text).toMatch(/starts a new one, not a continuation/)
  })
})

// --- real helper pipeline ---------------------------------------------------

interface HelperRun {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

type Json = Record<string, unknown>

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asJson(value: unknown): Json {
  if (!isJson(value)) throw new Error('expected a JSON object')
  return value
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected a JSON array')
  return value
}

function runHelper(args: readonly string[], input: string): HelperRun {
  const result = spawnSync('node', [VALIDATOR, ...args], {
    input,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** One `screen` call, parsed. Exit 2 has no stdout, so `parsed` is undefined. */
function screen(reviewer: string, rawReturn: string) {
  const run = runHelper(
    ['screen', '--reviewer', reviewer, '--harness', 'opencode'],
    rawReturn,
  )
  return {
    status: run.status,
    stderr: run.stderr,
    parsed: run.stdout.length > 0 ? asJson(JSON.parse(run.stdout)) : undefined,
  }
}

/** The persona's `prepare` entry: a bare result on exit 0, `screen` on exit 1. */
function terminalOf(
  reviewer: string,
  call: ReturnType<typeof screen>,
): { reviewer: string; result: unknown } {
  if (call.parsed === undefined) throw new Error('screen produced no result')
  return {
    reviewer,
    result: call.status === 0 ? call.parsed : call.parsed.screen,
  }
}

const SECURITY_SURFACE = ['src/auth.ts']
const CLEAN_VERDICT = 'All requirements met.'
const WITHHELD_VERDICT =
  'Review did not reach a clean verdict; see blocking reasons and coverage for detail.'

/** What the parent writes for a persona that never produced a `screen` result. */
function lifecycleEntry(
  reviewer: string,
  outcome: 'never_returned' | 'validation_unavailable',
): Terminal {
  return {
    reviewer,
    result: {
      dispatch_outcome: outcome,
      admitted_findings: [],
      residual_risks: [],
      testing_gaps: [],
      harness: 'opencode',
    },
  }
}

function validReturn(reviewer: string, file: string): string {
  return JSON.stringify(buildScreenReturn({ reviewer, findings: [{ file }] }))
}

/** A return `screen` rejects on `field`, with a value outside the closed set. */
function returnBrokenAt(
  reviewer: string,
  file: string,
  field: 'severity' | 'owner',
): string {
  const payload = asJson(buildScreenReturn({ reviewer, findings: [{ file }] }))
  const finding = asJson(asArray(payload.findings)[0])
  finding[field] = 'not-in-the-set'
  return JSON.stringify(payload)
}

interface Dispatch {
  readonly persona: string
  readonly dispatch_outcome: string
  readonly selection_surface?: readonly string[]
}

interface Terminal {
  readonly reviewer: string
  readonly result: unknown
}

function phase(name: string, input: unknown) {
  const run = runHelper([name], JSON.stringify(input))
  return {
    status: run.status,
    stderr: run.stderr,
    value: run.status === 0 ? asJson(JSON.parse(run.stdout)) : undefined,
  }
}

/** Real `prepare`, `merge` and `finalize` over the personas' terminal results. */
function finalizeTerminals(
  terminals: readonly Terminal[],
  dispatches: readonly Dispatch[],
) {
  const prepared = phase('prepare', {
    screen_results: terminals,
    selected_dispatches: dispatches,
  })
  if (prepared.value === undefined) {
    throw new Error(`prepare exited ${prepared.status}: ${prepared.stderr}`)
  }
  expect(asArray(prepared.value.candidate_groups)).toEqual([])
  const merged = phase('merge', {
    prepared: prepared.value,
    adjudication: { decisions: [] },
  })
  if (merged.value === undefined) {
    throw new Error(`merge exited ${merged.status}: ${merged.stderr}`)
  }
  const finalized = phase('finalize', {
    merge: merged.value,
    prepared: prepared.value,
    screen_results: terminals,
    dispatch_records: dispatches,
    validator_lifecycle_results: [],
    plan_assessment: { verdict: 'All requirements met.', results: [] },
    parent_run_metadata: {
      run_id: 'run-1',
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
  if (finalized.value === undefined) {
    throw new Error(`finalize exited ${finalized.status}: ${finalized.stderr}`)
  }
  const artifact = asJson(finalized.value.artifact)
  const report = asJson(finalized.value.report)
  return {
    artifact,
    dispatches: asArray(artifact.dispatches).map(asJson),
    verdict: artifact.verdict,
    riskCoverage: asArray(artifact.risk_coverage ?? []),
    failedReviewers: asArray(asJson(report.coverage).failed_reviewers),
  }
}

function dispatchFor(
  dispatches: readonly Json[],
  persona: string,
): Json | undefined {
  return dispatches.find((entry) => entry.persona === persona)
}

const CORRECTNESS_DISPATCH: Dispatch = {
  persona: 'correctness',
  dispatch_outcome: 'findings',
}

function securityDispatch(outcome: string): Dispatch {
  return {
    persona: 'security',
    dispatch_outcome: outcome,
    selection_surface: SECURITY_SURFACE,
  }
}

describe('one terminal result per persona (real helper)', () => {
  test('reject then accept: only the corrected return enters prepare and finalize', () => {
    const first = screen(
      'security',
      returnBrokenAt('security', 'src/auth.ts', 'severity'),
    )
    const second = screen('security', validReturn('security', 'src/auth.ts'))
    const correctness = screen(
      'correctness',
      validReturn('correctness', 'src/a.ts'),
    )

    expect(first.status).toBe(1)
    expect(second.status).toBe(0)
    expect(correctness.status).toBe(0)

    const run = finalizeTerminals(
      [terminalOf('correctness', correctness), terminalOf('security', second)],
      [CORRECTNESS_DISPATCH, securityDispatch('findings')],
    )

    expect(run.dispatches).toHaveLength(2)
    const security = dispatchFor(run.dispatches, 'security')
    expect(security?.dispatch_outcome).toBe('findings')
    expect(security?.input_finding_count).toBe(1)
    expect(security && 'rejection_reason' in security).toBe(false)
    expect(run.artifact.run_status).toBe('completed')
    expect(run.verdict).toBe(CLEAN_VERDICT)
    expect(run.riskCoverage).toEqual([])
    expect(run.failedReviewers).toEqual([])
  })

  test('prepare still rejects the rejected and the corrected result together as a duplicate persona', () => {
    const first = screen(
      'security',
      returnBrokenAt('security', 'src/auth.ts', 'severity'),
    )
    const second = screen('security', validReturn('security', 'src/auth.ts'))

    const both = phase('prepare', {
      screen_results: [
        terminalOf('security', first),
        terminalOf('security', second),
      ],
      selected_dispatches: [securityDispatch('findings')],
    })

    expect(both.status).toBe(1)
    expect(both.stderr).toContain('duplicate persona outcome')
  })

  test('reject then reject: the second malformed result is terminal, carries its reason, and blocks a clean verdict', () => {
    const first = screen(
      'security',
      returnBrokenAt('security', 'src/auth.ts', 'severity'),
    )
    const second = screen(
      'security',
      returnBrokenAt('security', 'src/auth.ts', 'owner'),
    )
    const correctness = screen(
      'correctness',
      validReturn('correctness', 'src/a.ts'),
    )

    expect(first.status).toBe(1)
    expect(second.status).toBe(1)
    expect(asJson(first.parsed?.rejection).code).toBe('schema_validation')
    expect(asJson(second.parsed?.rejection).code).toBe('schema_validation')

    const run = finalizeTerminals(
      [terminalOf('correctness', correctness), terminalOf('security', second)],
      [CORRECTNESS_DISPATCH, securityDispatch('malformed')],
    )

    expect(run.dispatches).toHaveLength(2)
    const security = dispatchFor(run.dispatches, 'security')
    expect(security?.dispatch_outcome).toBe('malformed')
    expect(security?.rejection_reason).toContain('findings.0.owner')
    expect(security?.rejection_reason).not.toContain('findings.0.severity')
    expect(run.artifact.run_status).toBe('degraded')
    expect(run.verdict).toBe(WITHHELD_VERDICT)
    expect(run.riskCoverage).toEqual([
      { persona: 'security', satisfied: false },
    ])
    expect(run.failedReviewers).toContain('security')
  })

  test('no continuation: the first malformed result is terminal after a single screen', () => {
    const only = screen(
      'security',
      returnBrokenAt('security', 'src/auth.ts', 'severity'),
    )
    const correctness = screen(
      'correctness',
      validReturn('correctness', 'src/a.ts'),
    )

    expect(only.status).toBe(1)

    const run = finalizeTerminals(
      [terminalOf('correctness', correctness), terminalOf('security', only)],
      [CORRECTNESS_DISPATCH, securityDispatch('malformed')],
    )

    expect(run.dispatches).toHaveLength(2)
    const security = dispatchFor(run.dispatches, 'security')
    expect(security?.dispatch_outcome).toBe('malformed')
    expect(security?.rejection_reason).toContain('findings.0.severity')
    expect(run.artifact.run_status).toBe('degraded')
    expect(run.verdict).toBe(WITHHELD_VERDICT)
    expect(run.riskCoverage).toEqual([
      { persona: 'security', satisfied: false },
    ])
  })

  test('a rejection without a helper row stays malformed with no invented rejection_reason', () => {
    const fenced = screen(
      'correctness',
      `\`\`\`json\n${validReturn('correctness', 'src/a.ts')}\n\`\`\``,
    )

    expect(fenced.status).toBe(1)
    expect(asJson(fenced.parsed?.rejection).code).toBe('malformed_json')
    expect(asJson(fenced.parsed?.screen).rejected_summary).toBeUndefined()

    const run = finalizeTerminals(
      [terminalOf('correctness', fenced)],
      [{ persona: 'correctness', dispatch_outcome: 'malformed' }],
    )

    const correctness = dispatchFor(run.dispatches, 'correctness')
    expect(correctness?.dispatch_outcome).toBe('malformed')
    expect(correctness && 'rejection_reason' in correctness).toBe(false)
    expect(asArray(run.artifact.input_findings)).toEqual([])
  })

  test('malformed, never-returned and validation-unavailable keep three distinct outcomes', () => {
    const accepted = screen(
      'correctness',
      validReturn('correctness', 'src/a.ts'),
    )
    const malformed = screen('testing', 'not json at all')
    const withheld = screen('adversarial', '   \n')

    expect(malformed.status).toBe(1)
    // Empty stdin never arrived, so it is a launch failure with no stdout.
    expect(withheld.status).toBe(2)
    expect(withheld.parsed).toBeUndefined()

    const run = finalizeTerminals(
      [
        terminalOf('correctness', accepted),
        terminalOf('testing', malformed),
        lifecycleEntry('maintainability', 'never_returned'),
        lifecycleEntry('adversarial', 'validation_unavailable'),
      ],
      [
        CORRECTNESS_DISPATCH,
        { persona: 'testing', dispatch_outcome: 'malformed' },
        { persona: 'maintainability', dispatch_outcome: 'never_returned' },
        { persona: 'adversarial', dispatch_outcome: 'validation_unavailable' },
      ],
    )

    expect(run.dispatches).toHaveLength(4)
    const outcomes = Object.fromEntries(
      run.dispatches.map((entry) => [entry.persona, entry.dispatch_outcome]),
    )
    expect(outcomes).toEqual({
      correctness: 'findings',
      testing: 'malformed',
      maintainability: 'never_returned',
      adversarial: 'validation_unavailable',
    })
    expect(run.artifact.run_status).toBe('degraded')
    for (const persona of ['testing', 'maintainability', 'adversarial']) {
      expect(run.failedReviewers).toContain(persona)
    }
    expect(
      asArray(run.artifact.input_findings).map((row) => asJson(row).reviewer),
    ).not.toContain('adversarial')
  })

  test('an exit 2 retry with identical bytes yields the same empty result and no screen result', () => {
    const first = screen('security', '')
    const retry = screen('security', '')

    expect(first.status).toBe(2)
    expect(retry.status).toBe(2)
    expect(first.parsed).toBeUndefined()
    expect(retry.parsed).toBeUndefined()
    expect(retry.stderr).toBe(first.stderr)

    // The persona can still be re-asked afterwards: nothing was consumed.
    const rejected = screen(
      'security',
      returnBrokenAt('security', 'src/auth.ts', 'severity'),
    )
    const corrected = screen('security', validReturn('security', 'src/auth.ts'))
    expect(rejected.status).toBe(1)
    expect(corrected.status).toBe(0)
  })
})

describe('finalize plan-assessment verdict text', () => {
  test('names the three allowed verdict strings and the non-clean replacement', () => {
    const finalize = normalize(sectionByHeading(PIPELINE, '## finalize'))
    expect(finalize).toContain(
      '`plan_assessment.verdict` is exactly one of `Ready to merge`, `Ready with fixes`, or `Not ready`',
    )
    expect(finalize).toContain(
      'finalize replaces it with a fixed non-clean phrase otherwise',
    )
  })
})
