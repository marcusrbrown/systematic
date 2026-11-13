// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the workflow's expressions and shell parameters are literal text in these tests
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { decisionLine, manifestMarker } from '../../src/lib/connect-ci.js'
import { projectName } from '../../src/lib/connect-helper-core.js'
import {
  prepareStateRoot,
  readCiRunMarker,
} from '../../src/lib/connect-state.js'

// Script tests run real shell steps and the bundled helper, which can take
// several seconds each when the suite runs alongside other files.
setDefaultTimeout(30_000)

const ROOT = process.cwd()
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/connect.yaml')
const FRO_BOT_PATH = path.join(ROOT, '.github/workflows/fro-bot.yaml')
const HELPER_SOURCE = path.join(ROOT, 'skills/ce-connect/scripts/connect.mjs')

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

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

const SOURCE = fs.readFileSync(WORKFLOW_PATH, 'utf8')
const WORKFLOW = asRecord(
  yaml.load(SOURCE, { schema: yaml.JSON_SCHEMA }),
  'workflow',
)
const JOBS = asRecord(WORKFLOW.jobs, 'jobs')
const WORKFLOW_ENV = Object.fromEntries(
  Object.entries(asRecord(WORKFLOW.env, 'env')).map(([key, value]) => [
    key,
    String(value),
  ]),
)

const JOB_IDS = ['prepare', 'run', 'render', 'post'] as const
type JobId = (typeof JOB_IDS)[number]

function job(id: JobId): RecordValue {
  return asRecord(JOBS[id], `${id} job`)
}

function stepsOf(id: JobId): RecordValue[] {
  return asArray(job(id).steps, `${id} steps`).map((step, index) =>
    asRecord(step, `${id} step ${index}`),
  )
}

function stepNamed(id: JobId, name: string): RecordValue {
  const step = stepsOf(id).find((candidate) => candidate.name === name)
  if (step === undefined) throw new Error(`step not found: ${id}/${name}`)
  return step
}

function stepIndex(id: JobId, name: string): number {
  return stepsOf(id).findIndex((candidate) => candidate.name === name)
}

function allSteps(): Array<{ id: JobId; step: RecordValue }> {
  return JOB_IDS.flatMap((id) => stepsOf(id).map((step) => ({ id, step })))
}

function withOf(id: JobId, name: string): RecordValue {
  return asRecord(stepNamed(id, name).with, `${name} with`)
}

const GUARD =
  "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)"
const CONNECT_TITLE = 'ce:connect report — 2026-11-12 (UTC)'
const FRO_BOT_TITLE = 'Daily Fro Bot Report — 2026-11-12 (UTC)'
const AGENT_STEP = 'Run ce:connect'
const CHECKOUT_STEP = 'Check out the shared agent action'
const SHARED_ACTION_FILE = '.github/actions/fro-bot-agent/action.yml'
const SHARED_ACTION_USES = './.github/actions/fro-bot-agent'
const STEP_TIMEOUT_EXPRESSION =
  "${{ fromJSON(vars.FRO_BOT_CONNECT_STEP_TIMEOUT || '40') }}"

// ── Structure ───────────────────────────────────────────────────────────────

describe('connect workflow structure', () => {
  it('runs on a daily schedule and on dispatch only', () => {
    const on = asRecord(WORKFLOW.on, 'on')
    expect(Object.keys(on).sort()).toEqual(['schedule', 'workflow_dispatch'])
    const schedule = asArray(on.schedule, 'schedule')
    expect(schedule).toHaveLength(1)
    const cron = asString(asRecord(schedule[0], 'cron entry').cron, 'cron')
    expect(cron).toMatch(/^([1-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* \*$/)
  })

  it('serializes runs in one group without cancelling a run in progress', () => {
    expect(WORKFLOW.concurrency).toEqual({
      group: 'ce-connect-scheduled',
      'cancel-in-progress': false,
      queue: 'max',
    })
  })

  it('grants no permissions at the top and the narrowest set per job', () => {
    expect(WORKFLOW.permissions).toEqual({})
    expect(job('prepare').permissions).toEqual({
      contents: 'read',
      issues: 'read',
    })
    expect(job('run').permissions).toEqual({ contents: 'read' })
    expect(job('render').permissions).toEqual({})
    expect(job('post').permissions).toEqual({ issues: 'write' })
  })

  it('guards every job to the default branch and orders them with needs', () => {
    for (const id of JOB_IDS) {
      expect(asString(job(id).if, `${id} if`)).toContain(GUARD)
    }
    expect(job('run').needs).toBe('prepare')
    expect(job('render').needs).toEqual(['prepare', 'run'])
    expect(job('post').needs).toEqual(['prepare', 'render'])
    for (const id of ['render', 'post'] as const) {
      expect(asString(job(id).if, `${id} if`)).toContain('always()')
    }
    expect(asString(job('render').if, 'render if')).toContain(
      "needs.run.outputs.accepted == 'true'",
    )
    expect(asString(job('post').if, 'post if')).toContain(
      "needs.render.outputs.has-body == 'true'",
    )
    expect(asString(job('post').if, 'post if')).toContain(
      "needs.render.result == 'success'",
    )
  })

  it('gives every job a timeout and the run job more than the action default', () => {
    for (const id of JOB_IDS) {
      expect(typeof job(id)['timeout-minutes']).toBe('number')
    }
    expect(Number(job('run')['timeout-minutes'])).toBeGreaterThan(30)
  })

  it('bounds the agent step below the job so the steps after it still run', () => {
    const bound = stepNamed('run', 'Run ce:connect')['timeout-minutes']
    expect(bound).toBe(STEP_TIMEOUT_EXPRESSION)
    const fallback = Number(/\|\| '(\d+)'/.exec(String(bound))?.[1])
    expect(fallback).toBeGreaterThan(0)
    expect(fallback).toBeLessThan(Number(job('run')['timeout-minutes']))
  })

  it('checks out this repository in the run job only, for the shared agent action', () => {
    const checkouts = allSteps().filter(({ step }) =>
      String(step.uses ?? '').startsWith('actions/checkout@'),
    )
    expect(checkouts.map(({ id, step }) => [id, step.name])).toEqual([
      ['run', CHECKOUT_STEP],
    ])
    expect(SOURCE).not.toMatch(/\bbun (run|install|test)\b/)
  })

  it('pins every published action by full commit SHA and uses no other local action', () => {
    for (const { step } of allSteps()) {
      if (step.uses === undefined) continue
      const uses = String(step.uses)
      if (uses.startsWith('./')) {
        expect(uses).toBe(
          `./${asString(withOf('run', CHECKOUT_STEP).path, 'checkout path')}/${SHARED_ACTION_USES.slice(2)}`,
        )
        continue
      }
      expect(uses).toMatch(/^[\w./-]+@[0-9a-f]{40}$/)
    }
  })

  it('uses one Systematic version for the action and both helper installs', () => {
    const version = WORKFLOW_ENV.SYSTEMATIC_VERSION
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(SOURCE.split(version ?? '').length - 1).toBe(1)
    expect(withOf('run', 'Run ce:connect')['systematic-version']).toBe(
      '${{ env.SYSTEMATIC_VERSION }}',
    )
    for (const id of ['prepare', 'render'] as const) {
      const script = asString(stepNamed(id, 'Install helper').run, 'install')
      expect(script).toContain('@fro.bot/systematic@${SYSTEMATIC_VERSION}')
      expect(script).toContain('--ignore-scripts')
    }
  })

  it('reads the variables in one prepare step and nowhere else', () => {
    const names = [
      'FRO_BOT_CONNECT_PROJECTS',
      'FRO_BOT_CONNECT_MODEL',
      'FRO_BOT_CONNECT_VARIANT',
      'FRO_BOT_CONNECT_STEP_TIMEOUT',
    ]
    // The step timeout is also read where it bounds the agent step; prepare
    // validates it first, and the run job needs prepare.
    for (const name of names) {
      const reads = name === 'FRO_BOT_CONNECT_STEP_TIMEOUT' ? 2 : 1
      expect(SOURCE.split(`vars.${name}`).length - 1).toBe(reads)
    }
    const env = asRecord(
      stepNamed('prepare', 'Validate configuration').env,
      'config env',
    )
    expect(Object.values(env)).toEqual(
      expect.arrayContaining(names.map((name) => `\${{ vars.${name} }}`)),
    )
    expect(
      JSON.stringify(
        stepsOf('run').filter((step) => step.name !== 'Run ce:connect'),
      ),
    ).not.toContain('vars.')
  })

  it('keeps the report title apart from the Fro Bot daily report in both directions', () => {
    const connect = new RegExp(WORKFLOW_ENV.REPORT_TITLE_RE ?? '')
    const froBotRule = /`(\^Daily Fro Bot Report — [^`]+\$)`/.exec(
      fs.readFileSync(FRO_BOT_PATH, 'utf8'),
    )?.[1]
    expect(froBotRule).toBeDefined()
    const froBot = new RegExp(froBotRule ?? '')
    expect(connect.test(CONNECT_TITLE)).toBe(true)
    expect(connect.test(FRO_BOT_TITLE)).toBe(false)
    expect(froBot.test(FRO_BOT_TITLE)).toBe(true)
    expect(froBot.test(CONNECT_TITLE)).toBe(false)
    expect(connect.test(`${CONNECT_TITLE} extra`)).toBe(false)
    expect(connect.test(CONNECT_TITLE.replace('—', '-'))).toBe(false)
    expect(connect.test(CONNECT_TITLE.replace('11-12', '13-45'))).toBe(false)
  })

  it('names the report author as an exact login list holding only the Actions bot', () => {
    expect(JSON.parse(WORKFLOW_ENV.REPORT_AUTHORS ?? '[]')).toEqual([
      'github-actions[bot]',
    ])
  })
})

describe('connect workflow credentials', () => {
  it('references each provider secret once, as the action step input', () => {
    expect(SOURCE.split('secrets.OPENCODE_AUTH_JSON').length - 1).toBe(1)
    expect(SOURCE.split('secrets.OPENCODE_CONFIG').length - 1).toBe(1)
    const action = withOf('run', 'Run ce:connect')
    expect(action['auth-json']).toBe('${{ secrets.OPENCODE_AUTH_JSON }}')
    expect(action['opencode-config']).toBe('${{ secrets.OPENCODE_CONFIG }}')
    expect(SOURCE.match(/secrets\.[A-Z_]+/g)?.sort()).toEqual([
      'secrets.OPENCODE_AUTH_JSON',
      'secrets.OPENCODE_CONFIG',
    ])
  })

  it('gives the agent only the job token and keeps secrets out of env blocks', () => {
    expect(withOf('run', 'Run ce:connect')['github-token']).toBe(
      '${{ github.token }}',
    )
    for (const { step } of allSteps()) {
      if (step.env === undefined) continue
      for (const value of Object.values(asRecord(step.env, 'env'))) {
        expect(String(value)).not.toContain('secrets.')
      }
    }
    for (const id of JOB_IDS) {
      expect(job(id).env).toBeUndefined()
    }
  })

  it('leaves the action session cache alone and delivers nothing', () => {
    const action = withOf('run', 'Run ce:connect')
    expect(action).not.toHaveProperty('skip-cache')
    expect(action['response-mode']).toBe('none')
    expect(action['output-mode']).toBe('working-dir')
    expect(stepNamed('run', 'Run ce:connect')['continue-on-error']).toBe(true)
  })
})

// ── The shared agent step ───────────────────────────────────────────────────

// Both this workflow and the Fro Bot workflow run the fro-bot/agent action
// through one local composite action. What they share lives there; what each
// sets differently stays on its own step, with the reason beside it.
function readSharedAction(): { source: string; action: RecordValue } {
  const source = fs.readFileSync(path.join(ROOT, SHARED_ACTION_FILE), 'utf8')
  return {
    source,
    action: asRecord(
      yaml.load(source, { schema: yaml.JSON_SCHEMA }),
      'shared action',
    ),
  }
}

function sharedActionStep(): RecordValue {
  const { action } = readSharedAction()
  const steps = asArray(
    asRecord(action.runs, 'shared action runs').steps,
    'shared action steps',
  )
  expect(steps).toHaveLength(1)
  return asRecord(steps[0], 'shared action step')
}

/** The `uses` of a job or a composite's `runs`, and of each step in it. */
function usesOf(holder: unknown): string[] {
  if (!isRecord(holder)) return []
  const steps = Array.isArray(holder.steps) ? holder.steps : []
  return [holder, ...steps].flatMap((entry) =>
    isRecord(entry) && typeof entry.uses === 'string' ? [entry.uses] : [],
  )
}

/** Every `uses` in the repository's workflows and local actions, with the file it is in. */
function usesInRepository(): Array<{ file: string; uses: string }> {
  const files = [
    ...new Bun.Glob('.github/workflows/*.{yml,yaml}').scanSync({ cwd: ROOT }),
    ...new Bun.Glob('.github/actions/**/*.{yml,yaml}').scanSync({ cwd: ROOT }),
  ].sort()
  return files.flatMap((file) => {
    const parsed = asRecord(
      yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8'), {
        schema: yaml.JSON_SCHEMA,
      }),
      file,
    )
    // A job can call a reusable workflow itself, and a job or a composite
    // action holds the steps that call actions.
    const holders = [
      ...(isRecord(parsed.jobs) ? Object.values(parsed.jobs) : []),
      parsed.runs,
    ]
    return holders.flatMap(usesOf).map((uses) => ({ file, uses }))
  })
}

const FRO_BOT_SOURCE = fs.readFileSync(FRO_BOT_PATH, 'utf8')
const FRO_BOT = asRecord(
  yaml.load(FRO_BOT_SOURCE, { schema: yaml.JSON_SCHEMA }),
  'fro-bot workflow',
)
const FRO_BOT_AGENT_STEP = asArray(
  asRecord(asRecord(FRO_BOT.jobs, 'fro-bot jobs')['fro-bot'], 'fro-bot job')
    .steps,
  'fro-bot steps',
)
  .map((step, index) => asRecord(step, `fro-bot step ${index}`))
  .find((step) => step.name === 'Run Fro Bot')

function froBotAgentStep(): RecordValue {
  if (FRO_BOT_AGENT_STEP === undefined) {
    throw new Error('step not found: fro-bot/Run Fro Bot')
  }
  return FRO_BOT_AGENT_STEP
}

const SHARED_REQUIRED_INPUTS = [
  'auth-json',
  'github-token',
  'model',
  'opencode-config',
  'prompt',
]
// An empty optional input must act as an omitted one. The action reads every
// input below through `getInput(...).trim()` and treats an empty value as unset
// (fro-bot/agent src/harness/config/inputs.ts at the pinned SHA). The two inputs
// that have a non-empty default in the action's own action.yaml are given the
// same default here, so the runner never hands the action an empty string where
// its default would have applied.
const SHARED_OPTIONAL_DEFAULTS: Readonly<Record<string, string>> = {
  'brokered-push-extra-paths': '',
  'dedup-window': '600000',
  'output-mode': '',
  'response-mode': 'github',
  'systematic-version': '',
  'trusted-head-sha': '',
}

describe('the shared fro-bot agent action', () => {
  const connectStep = () => stepNamed('run', AGENT_STEP)

  it('holds the only fro-bot/agent reference in the workflows and local actions', () => {
    expect(
      usesInRepository().filter(({ uses }) =>
        uses.startsWith('fro-bot/agent@'),
      ),
    ).toEqual([
      {
        file: SHARED_ACTION_FILE,
        uses: expect.stringMatching(/^fro-bot\/agent@[0-9a-f]{40}$/),
      },
    ])
  })

  it('pins the action by full SHA with the version comment Renovate reads', () => {
    expect(readSharedAction().source).toMatch(
      /^\s+uses: fro-bot\/agent@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m,
    )
  })

  it('is a composite action with the one agent step', () => {
    const { action } = readSharedAction()
    expect(asRecord(action.runs, 'runs').using).toBe('composite')
    sharedActionStep()
  })

  it('owns the runtime settings both callers share', () => {
    const step = sharedActionStep()
    expect(asRecord(step.with, 'with').timeout).toBe(0)
    expect(asRecord(step.env, 'env')).toEqual({
      OPENCODE_PROMPT_ARTIFACT: 'true',
    })
  })

  it('requires the shared inputs and gives each optional input a default', () => {
    const inputs = asRecord(readSharedAction().action.inputs, 'inputs')
    expect(Object.keys(inputs).sort()).toEqual(
      [
        ...SHARED_REQUIRED_INPUTS,
        ...Object.keys(SHARED_OPTIONAL_DEFAULTS),
      ].sort(),
    )
    for (const name of SHARED_REQUIRED_INPUTS) {
      const input = asRecord(inputs[name], name)
      expect(input.required).toBe(true)
      expect(input).not.toHaveProperty('default')
    }
    for (const [name, fallback] of Object.entries(SHARED_OPTIONAL_DEFAULTS)) {
      const input = asRecord(inputs[name], name)
      expect(input.required).toBe(false)
      expect(input.default).toBe(fallback)
    }
    for (const name of Object.keys(inputs)) {
      expect(typeof asRecord(inputs[name], name).description).toBe('string')
    }
  })

  it('hands every input to the action under its own name, and nothing else', () => {
    const inputs = Object.keys(
      asRecord(readSharedAction().action.inputs, 'inputs'),
    )
    const given = asRecord(sharedActionStep().with, 'with')
    expect(Object.keys(given).sort()).toEqual([...inputs, 'timeout'].sort())
    for (const name of inputs) {
      expect(given[name]).toBe(`\${{ inputs.${name} }}`)
    }
  })

  it('runs under both workflows and under no other path', () => {
    const checkoutPath = asString(
      withOf('run', CHECKOUT_STEP).path,
      'checkout path',
    )
    expect(connectStep().uses).toBe(
      `./${checkoutPath}/${SHARED_ACTION_USES.slice(2)}`,
    )
    expect(froBotAgentStep().uses).toBe(SHARED_ACTION_USES)
  })

  it('keeps the shared settings off both callers', () => {
    for (const step of [connectStep(), froBotAgentStep()]) {
      expect(asRecord(step.with, 'with')).not.toHaveProperty('timeout')
      expect(asRecord(step.env ?? {}, 'env')).not.toHaveProperty(
        'OPENCODE_PROMPT_ARTIFACT',
      )
    }
  })

  it('runs the parent agent on the model both callers read from FRO_BOT_MODEL', () => {
    for (const step of [connectStep(), froBotAgentStep()]) {
      expect(asRecord(step.with, 'with').model).toBe(
        '${{ vars.FRO_BOT_MODEL }}',
      )
    }
  })

  it('passes exactly the connect-only inputs, with their values and reasons', () => {
    const { prompt, ...given } = asRecord(connectStep().with, 'connect with')
    expect(typeof prompt).toBe('string')
    expect(given).toEqual({
      'auth-json': '${{ secrets.OPENCODE_AUTH_JSON }}',
      'opencode-config': '${{ secrets.OPENCODE_CONFIG }}',
      model: '${{ vars.FRO_BOT_MODEL }}',
      // The read-only job token, not the Fro Bot personal token.
      'github-token': '${{ github.token }}',
      // The skill and the helper must be one release.
      'systematic-version': '${{ env.SYSTEMATIC_VERSION }}',
      // Nothing is delivered to GitHub.
      'response-mode': 'none',
      // The run changes nothing, so no branch or pull request.
      'output-mode': 'working-dir',
      // A repeat run is never suppressed.
      'dedup-window': '0',
    })
    expect(connectStep()).not.toHaveProperty('env')
  })

  it('keeps the connect step bounded and the Fro Bot step unbounded by step', () => {
    expect(connectStep()['continue-on-error']).toBe(true)
    expect(connectStep()['timeout-minutes']).toBe(STEP_TIMEOUT_EXPRESSION)
    expect(typeof job('run')['timeout-minutes']).toBe('number')
    expect(froBotAgentStep()).not.toHaveProperty('timeout-minutes')
  })
})

describe('connect workflow layout, marker and prompt', () => {
  it('lays the connect directory out under the workspace, never the runner temp directory', () => {
    for (const { step } of stepsOf('run').map((step) => ({ step }))) {
      const text = JSON.stringify(step)
      expect(text).not.toMatch(/RUNNER_TEMP|runner\.temp/)
    }
    const layoutScript = asString(
      stepNamed('run', 'Create connect layout').run,
      'layout script',
    )
    expect(layoutScript).toContain('$GITHUB_WORKSPACE/connect')
    expect(layoutScript).toContain(
      'echo "XDG_STATE_HOME=${layout}/state" >> "$GITHUB_ENV"',
    )
    expect(
      asString(withOf('run', 'Download hand-off').path, 'download path'),
    ).toBe('${{ github.workspace }}/connect/state/systematic/connect')
  })

  it('writes the run marker file before the agent step and never passes it through env', () => {
    const marker = stepIndex('run', 'Write run marker')
    const agent = stepIndex('run', 'Run ce:connect')
    const read = stepIndex('run', 'Read run record')
    expect(marker).toBeGreaterThan(-1)
    expect(marker).toBeLessThan(agent)
    expect(agent).toBeLessThan(read)
    for (const { step } of allSteps()) {
      for (const key of Object.keys(asRecord(step.env ?? {}, 'env'))) {
        expect(key).not.toMatch(/MARKER/i)
      }
    }
    expect(SOURCE).not.toContain('SYSTEMATIC_CONNECT_RUN_MARKER')
  })

  it('prompts for the ce:connect task by name, not for a review', () => {
    const prompt = asString(withOf('run', 'Run ce:connect').prompt, 'prompt')
    expect(prompt).toContain('`ce:connect`')
    expect(prompt).toContain('`mode:headless`')
    expect(prompt).not.toMatch(/review/i)
    expect(prompt).not.toMatch(/pull request/i)
  })
})

describe('connect workflow injection and artifacts', () => {
  it('never puts an expression in a run body', () => {
    for (const { step } of allSteps()) {
      if (step.run === undefined) continue
      expect(String(step.run)).not.toContain('${{')
    }
    expect(SOURCE).not.toMatch(/github\.event\.(issue|comment)/)
  })

  it('uploads hand-off artifacts for one day and only allowlisted files', () => {
    const allowed =
      /\/(handoff\.json|ledger\.json|ci-payloads\.json|ci-manifests\.json|invocation\.json|runs\/\*\/run\.json|runs\/\*\/digest\.md)$/
    const handoffs: Array<[JobId, string]> = [
      ['prepare', 'Upload hand-off'],
      ['run', 'Upload hand-off'],
      ['render', 'Upload report'],
    ]
    for (const [id, name] of handoffs) {
      const step = stepNamed(id, name)
      const input = withOf(id, name)
      expect(input['retention-days']).toBe(1)
      expect(String(step.uses)).toContain('actions/upload-artifact@')
      // The name comes from the job's own naming step, so the job can hand
      // the exact name it used to the job that downloads it.
      expect(asString(input.name, 'name')).toBe(
        '${{ steps.artifact.outputs.name }}',
      )
      if (id === 'render') continue
      for (const line of asString(input.path, 'path').split('\n')) {
        if (line.trim() === '') continue
        expect(line.trim()).toMatch(allowed)
      }
    }
  })

  it('uploads the public run record from the render job only, as one file', () => {
    const publicName =
      'connect-run-${{ github.run_id }}-${{ github.run_attempt }}'
    const uploads = allSteps().filter(
      ({ step }) =>
        isRecord(step.with) && String(step.with.name ?? '') === publicName,
    )
    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.id).toBe('render')
    expect(withOf('render', 'Upload run record')).toMatchObject({
      path: '${{ runner.temp }}/public/run.json',
      'retention-days': 30,
      'if-no-files-found': 'error',
    })
  })

  it('restores and saves the cache with the same allowlisted paths', () => {
    const restore = withOf('prepare', 'Restore ledger cache')
    const save = withOf('render', 'Save ledger cache')
    expect(save.path).toBe(restore.path)
    expect(asString(restore.key, 'key')).toBe(
      'connect-v1-${{ github.run_id }}-${{ github.run_attempt }}',
    )
    expect(String(restore['restore-keys']).trim()).toBe('connect-v1-')
    expect(asString(restore.path, 'path')).not.toMatch(
      /lock|report\.md|invocation|ci-run/,
    )
  })
})

// ── Sandbox ─────────────────────────────────────────────────────────────────

const GH_STUB = String.raw`#!/usr/bin/env bash
echo "gh $*" >> "$GH_LOG"
fx="$GH_FIXTURES"
issues="$fx/issues.json"
args=("$@")
jqexpr=""; method=GET; title=""; bodyfile=""; state=""; endpoint=""
i=0
while [ $i -lt \${#args[@]} ]; do
  a="\${args[$i]}"
  case "$a" in
    --jq) i=$((i + 1)); jqexpr="\${args[$i]}" ;;
    -X) i=$((i + 1)); method="\${args[$i]}" ;;
    -f | -F)
      i=$((i + 1)); kv="\${args[$i]}"
      case "$kv" in
        title=*) title="\${kv#title=}" ;;
        body=@*) bodyfile="\${kv#body=@}" ;;
        state=closed) state=closed ;;
      esac ;;
    repos/*) endpoint="$a" ;;
  esac
  i=$((i + 1))
done
if [ -n "\${GH_FAIL_AT:-}" ] && [[ "$*" == *"\${GH_FAIL_AT}"* ]]; then exit 1; fi
emit() { if [ -n "$jqexpr" ]; then jq -r "$jqexpr"; else cat; fi; }
[ -f "$issues" ] || echo '[]' > "$issues"
case "$method $endpoint" in
  "GET repos/"*"/issues?state=open"*)
    [ -z "\${GH_FAIL_LIST:-}" ] || exit 1
    jq '[.[] | select(.state == "open")]' "$issues" | emit ;;
  "GET repos/"*"/issues/"*)
    n="\${endpoint##*/}"
    jq --argjson n "$n" '.[] | select(.number == $n)' "$issues" | emit ;;
  "POST repos/"*"/issues/"*"/comments") exit 0 ;;
  "POST repos/"*"/issues")
    n=$(jq '([.[].number] | max // 100) + 1' "$issues")
    body=""; [ -z "$bodyfile" ] || body=$(cat "$bodyfile")
    jq --argjson n "$n" --arg t "$title" --arg b "$body" --arg u "\${GH_ACTOR:-github-actions[bot]}" \
      '. + [{number: $n, title: $t, body: $b, state: "open", user: {login: $u}}]' "$issues" > "$issues.next"
    mv "$issues.next" "$issues"
    echo "{\"number\": $n}" | emit ;;
  "PATCH repos/"*"/issues/"*)
    n="\${endpoint##*/}"
    body=""; [ -z "$bodyfile" ] || body=$(cat "$bodyfile")
    jq --argjson n "$n" --arg t "$title" --arg b "$body" --arg s "$state" --arg hasBody "$bodyfile" '
      map(if .number == $n then
        (if $t != "" then .title = $t else . end)
        | (if $hasBody != "" then .body = $b else . end)
        | (if $s != "" then .state = $s else . end)
      else . end)' "$issues" > "$issues.next"
    mv "$issues.next" "$issues" ;;
  "GET repos/"*)
    slug="\${endpoint#repos/}"; slug="\${slug/\//__}"
    visibility=public
    [ ! -f "$fx/visibility-$slug" ] || visibility=$(cat "$fx/visibility-$slug")
    [ "$visibility" != ERROR ] || exit 1
    echo "{\"visibility\": \"$visibility\"}" | emit ;;
  *) exit 1 ;;
esac
`.replaceAll('\\${', '${')

const NPM_STUB = `#!/usr/bin/env bash
echo "npm $*" >> "$GH_LOG"
prefix=""
while [ $# -gt 0 ]; do
  if [ "$1" = --prefix ]; then prefix="$2"; fi
  shift
done
dest="$prefix/node_modules/@fro.bot/systematic/skills/ce-connect/scripts"
mkdir -p "$dest"
cp "$HELPER_SRC" "$dest/connect.mjs"
`

const GIT_STUB = `#!/usr/bin/env bash
echo "git $*" >> "$GH_LOG"
if [ "$1" = "-c" ]; then shift 2; fi
if [ "$1" = clone ]; then
  dest="\${@: -1}"
  mkdir -p "$dest/.git"
fi
exit 0
`

const DATE_STUB = `#!/usr/bin/env bash
if [ -n "\${FAKE_DATE:-}" ] && [ "$1" = -u ]; then echo "$FAKE_DATE"; exit 0; fi
exec /bin/date "$@"
`

interface Box {
  dir: string
  log: string
  fixtures: string
  tmp: string
  ws: string
  home: string
  output: string
  githubEnv: string
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeBox(): Box {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'connect-workflow-')),
  )
  dirs.push(dir)
  const box: Box = {
    dir,
    log: path.join(dir, 'calls.log'),
    fixtures: path.join(dir, 'fixtures'),
    tmp: path.join(dir, 'tmp'),
    ws: path.join(dir, 'ws'),
    home: path.join(dir, 'home'),
    output: path.join(dir, 'output.txt'),
    githubEnv: path.join(dir, 'github-env.txt'),
  }
  for (const sub of [box.fixtures, box.tmp, box.ws, box.home]) {
    fs.mkdirSync(sub, { recursive: true })
  }
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const stubs: Array<[string, string]> = [
    ['gh', GH_STUB],
    ['npm', NPM_STUB],
    ['git', GIT_STUB],
    ['date', DATE_STUB],
  ]
  for (const [name, text] of stubs) {
    fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 })
  }
  return box
}

interface StepResult {
  exitCode: number
  stdout: string
  stderr: string
  outputs: Map<string, string>
}

function runStep(
  box: Box,
  id: JobId,
  name: string,
  env: Record<string, string> = {},
): StepResult {
  fs.rmSync(box.output, { force: true })
  const script = asString(stepNamed(id, name).run, `${name} run`)
  const result = Bun.spawnSync(
    ['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', script],
    {
      cwd: box.dir,
      env: {
        PATH: `${path.join(box.dir, 'bin')}:${process.env.PATH ?? ''}`,
        HOME: box.home,
        RUNNER_TEMP: box.tmp,
        GITHUB_WORKSPACE: box.ws,
        GITHUB_OUTPUT: box.output,
        GITHUB_ENV: box.githubEnv,
        GITHUB_RUN_ID: '555',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: 'marcusrbrown/systematic',
        GH_TOKEN: 'stub-token',
        GH_LOG: box.log,
        GH_FIXTURES: box.fixtures,
        HELPER_SRC: HELPER_SOURCE,
        ...WORKFLOW_ENV,
        ...env,
      },
    },
  )
  const outputs = new Map<string, string>()
  if (fs.existsSync(box.output)) {
    for (const line of fs.readFileSync(box.output, 'utf8').split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) outputs.set(line.slice(0, eq), line.slice(eq + 1))
    }
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    outputs,
  }
}

function calls(box: Box): string[] {
  return fs.existsSync(box.log)
    ? fs.readFileSync(box.log, 'utf8').split('\n').filter(Boolean)
    : []
}

function ghWrites(box: Box): string[] {
  return calls(box).filter(
    (line) => /-X (POST|PATCH)/.test(line) && line.startsWith('gh '),
  )
}

interface FixtureIssue {
  number: number
  title: string
  body?: string
  state?: string
  login?: string
  pr?: boolean
}

function writeIssues(box: Box, issues: readonly FixtureIssue[]): void {
  fs.writeFileSync(
    path.join(box.fixtures, 'issues.json'),
    JSON.stringify(
      issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? '',
        state: issue.state ?? 'open',
        user: { login: issue.login ?? 'github-actions[bot]' },
        ...(issue.pr === true ? { pull_request: {} } : {}),
      })),
    ),
  )
}

function issuesOf(box: Box): FixtureIssue[] {
  return JSON.parse(
    fs.readFileSync(path.join(box.fixtures, 'issues.json'), 'utf8'),
  ) as FixtureIssue[]
}

const titleOn = (date: string): string => `ce:connect report — ${date} (UTC)`
const DATE_ONE = '2026-11-12'
const DATE_TWO = '2026-11-13'

// ── State fixtures ──────────────────────────────────────────────────────────

const CONNECT_RUN = '20261112T010000Z-abcd1234'
const PROJECT_ROOT = '/runner/work/connect/checkouts/acme__target'
const PROJECT_KEY = '0123456789ab'
/** The checkout directory the workflow names for `other/repo`; the helper uses it as the project name. */
const SOURCE_PROJECT = 'other__repo'

function sha(text: string): string {
  return Bun.CryptoHasher.hash('sha256', text, 'hex')
}

/** The id of the nth fixture candidate. A real id is a sha256 as well. */
function idOf(index: number): string {
  return sha(`candidate-${index}`)
}

function stateRootOf(box: Box): string {
  return path.join(box.tmp, 'connect-state', 'systematic', 'connect')
}

function handoffOf(box: Box): string {
  return path.join(box.tmp, 'handoff')
}

type Json = Record<string, unknown>

function entryOf(index: number): Json {
  return {
    id: idOf(index),
    kind: 'transferable-lesson',
    target: PROJECT_ROOT,
    ruleId: 'rule-0123456789abcdef',
    sources: [
      {
        role: 'source',
        path: `docs/solutions/lesson-${index}.md`,
        fingerprint: sha(`fingerprint-${index}`),
      },
    ],
    targetEvidence: [],
    status: 'candidate',
    history: [],
    recordedAt: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
  }
}

function blockCandidate(index: number, over: Json = {}): Json {
  return {
    id: idOf(index),
    status: 'candidate',
    standing: 'new',
    possibleMatches: [],
    kind: 'transferable-lesson',
    ruleId: 'rule-0123456789abcdef',
    target: PROJECT_ROOT,
    targetName: 'target',
    title: `Lesson ${index}`,
    summary: `Summary of lesson ${index}.`,
    nextStep: 'compound-learning',
    overlapCheck: { queries: ['q'], result: 'none-found' },
    sources: [
      {
        project: PROJECT_KEY,
        projectName: SOURCE_PROJECT,
        path: `docs/solutions/lesson-${index}.md`,
        fingerprint: sha(`fingerprint-${index}`),
        excerpt: `Excerpt of lesson ${index} from the source learning.`,
        cite: 'x',
      },
    ],
    targetEvidence: [],
    counterevidence: [],
    ...over,
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

interface SeedOptions {
  /** Candidates the ledger holds open and this run's record proposes. */
  count?: number
  marker?: string
  invocation?: Json | null
  candidates?: Json[]
}

/** The files a run job hands to render: ledger, run record and invocation record. */
function seedHandoff(box: Box, options: SeedOptions = {}): string {
  const dir = handoffOf(box)
  fs.rmSync(dir, { recursive: true, force: true })
  const count = options.count ?? 2
  const numbers = Array.from({ length: count }, (_, i) => i + 1)
  writeJson(path.join(dir, 'ledger.json'), {
    version: 2,
    entries: numbers.map(entryOf),
  })
  writeJson(path.join(dir, 'runs', CONNECT_RUN, 'run.json'), {
    schemaVersion: 1,
    runId: CONNECT_RUN,
    createdAt: '2026-11-12T01:00:00.000Z',
    outcome: 'complete',
    degradeReasons: [],
    mode: 'headless',
    selection: { kind: 'all' },
    projects: [
      {
        name: 'target',
        root: PROJECT_ROOT,
        key: PROJECT_KEY,
        repo: 'acme/target',
        commit: 'a'.repeat(40),
      },
    ],
    sweep: { total: 40, covered: 12, coveredThisRun: 8, runsLeft: 4 },
    candidateBlock: {
      schemaVersion: 1,
      candidates: options.candidates ?? numbers.map((n) => blockCandidate(n)),
    },
  })
  if (options.invocation !== null) {
    writeJson(path.join(dir, 'invocation.json'), {
      version: 1,
      marker: options.marker ?? '555-1',
      phase: 'terminal',
      outcome: 'complete',
      finalLine: 'Connect complete',
      runId: CONNECT_RUN,
      projects: [{ key: PROJECT_KEY, name: 'target', repo: 'acme/target' }],
      ...options.invocation,
    })
  }
  return dir
}

/** Copy the state a later run starts from: what the cache holds, as a hand-off. */
function handoffFromState(box: Box, invocation: Json): void {
  const dir = handoffOf(box)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.cpSync(stateRootOf(box), dir, { recursive: true })
  for (const stale of ['invocation.json', 'report.md', 'lock', 'ci-run.json']) {
    fs.rmSync(path.join(dir, stale), { recursive: true, force: true })
  }
  writeJson(path.join(dir, 'invocation.json'), {
    version: 1,
    phase: 'terminal',
    outcome: 'complete',
    finalLine: 'Connect complete',
    runId: CONNECT_RUN,
    projects: [{ key: PROJECT_KEY, name: 'target', repo: 'acme/target' }],
    ...invocation,
  })
}

/** Validate the hand-off, install the helper and render the report for one day. */
function renderDay(
  box: Box,
  date: string,
  options: { cacheRestored?: boolean; run?: string } = {},
): { render: StepResult; body: string } {
  const env = { GITHUB_RUN_ID: options.run ?? '555' }
  const validate = runStep(box, 'render', 'Validate hand-off', env)
  expect(validate.stderr).toBe('')
  expect(validate.exitCode).toBe(0)
  expect(runStep(box, 'render', 'Install helper', env).exitCode).toBe(0)
  const render = runStep(box, 'render', 'Render report', {
    ...env,
    DATE: date,
    CACHE_RESTORED: String(options.cacheRestored ?? true),
  })
  const bodyFile = path.join(box.tmp, 'report', 'body.md')
  return {
    render,
    body: fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : '',
  }
}

function finalize(
  box: Box,
  render: StepResult,
  cacheSave = 'success',
  cacheHit = 'true',
): StepResult {
  return runStep(box, 'render', 'Finalize report', {
    RENDER_RED: render.outputs.get('red') ?? '',
    RENDER_MANIFEST: render.outputs.get('manifest') ?? '',
    RENDER_OUTCOME: render.outputs.get('outcome') ?? '',
    CACHE_SAVE_OUTCOME: cacheSave,
    CACHE_HIT: cacheHit,
  })
}

function tick(body: string, index: number, status: 'promoted' | 'rejected') {
  const open = decisionLine(idOf(index), status, false)
  if (!body.includes(open)) throw new Error(`no box for ${index} ${status}`)
  return body.replace(open, decisionLine(idOf(index), status, true))
}

function ledgerBytes(box: Box): string {
  return fs.readFileSync(path.join(stateRootOf(box), 'ledger.json'), 'utf8')
}

function statusOf(box: Box, index: number): string | undefined {
  const ledger = JSON.parse(ledgerBytes(box)) as {
    entries: Array<{ id: string; status: string }>
  }
  return ledger.entries.find((entry) => entry.id === idOf(index))?.status
}

const CONFIG_ENV = {
  PROJECTS_RAW: 'Acme/Target, other/repo',
  MODEL: 'anthropic/claude-sonnet-5-5',
  VARIANT: 'high',
}

// ── Prepare ─────────────────────────────────────────────────────────────────

describe('prepare: date and configuration', () => {
  it('computes the UTC date once and exposes it', () => {
    const box = makeBox()
    const result = runStep(box, 'prepare', 'Compute UTC date', {
      FAKE_DATE: DATE_ONE,
    })
    expect(result.exitCode).toBe(0)
    expect(result.outputs.get('date')).toBe(DATE_ONE)
  })

  it('stops on a date with an unexpected shape', () => {
    for (const fake of ['2026-13-45', 'Thu Nov 12', '2026-11-1']) {
      const box = makeBox()
      const result = runStep(box, 'prepare', 'Compute UTC date', {
        FAKE_DATE: fake,
      })
      expect(result.exitCode).toBe(1)
      expect(result.outputs.has('date')).toBe(false)
    }
  })

  it('lowercases, deduplicates and exposes a valid configuration', () => {
    const box = makeBox()
    const result = runStep(box, 'prepare', 'Validate configuration', {
      ...CONFIG_ENV,
      PROJECTS_RAW: 'Acme/Target other/repo,acme/target\n  third/one',
    })
    expect(result.exitCode).toBe(0)
    expect(result.outputs.get('projects')).toBe(
      'acme/target other/repo third/one',
    )
    expect(result.outputs.get('model')).toBe(CONFIG_ENV.MODEL)
    expect(result.outputs.get('variant')).toBe('high')
    expect(
      calls(box).filter((line) => line.startsWith('gh api repos/')),
    ).toHaveLength(3)
  })

  it('accepts an unset variant', () => {
    const box = makeBox()
    const result = runStep(box, 'prepare', 'Validate configuration', {
      ...CONFIG_ENV,
      VARIANT: '',
    })
    expect(result.exitCode).toBe(0)
    expect(result.outputs.get('variant')).toBe('')
  })

  it('accepts an unset step timeout and any whole number of minutes below the job timeout', () => {
    const jobLimit = Number(job('run')['timeout-minutes'])
    for (const value of ['', '1', '40', String(jobLimit - 1)]) {
      const box = makeBox()
      const result = runStep(box, 'prepare', 'Validate configuration', {
        ...CONFIG_ENV,
        STEP_TIMEOUT: value,
      })
      expect(result.exitCode).toBe(0)
      expect(result.outputs.get('projects')).toBe('acme/target other/repo')
    }
  })

  it('checks the step timeout against the same limit the run job has', () => {
    const script = asString(
      stepNamed('prepare', 'Validate configuration').run,
      'config script',
    )
    const limit = /job_limit=(\d+)/.exec(script)?.[1]
    expect(Number(limit)).toBe(Number(job('run')['timeout-minutes']))
  })

  const failures: Array<[string, Record<string, string>, (box: Box) => void]> =
    [
      [
        'a step timeout equal to the job timeout',
        { STEP_TIMEOUT: '50' },
        () => undefined,
      ],
      [
        'a step timeout above the job timeout',
        { STEP_TIMEOUT: '90' },
        () => undefined,
      ],
      ['a step timeout of zero', { STEP_TIMEOUT: '0' }, () => undefined],
      ['a negative step timeout', { STEP_TIMEOUT: '-5' }, () => undefined],
      ['a fractional step timeout', { STEP_TIMEOUT: '4.5' }, () => undefined],
      [
        'a step timeout that is not a number',
        { STEP_TIMEOUT: 'soon' },
        () => undefined,
      ],
      ['a step timeout with spaces', { STEP_TIMEOUT: ' 40 ' }, () => undefined],
      [
        'a step timeout with a leading zero',
        { STEP_TIMEOUT: '040' },
        () => undefined,
      ],
      ['a step timeout with a unit', { STEP_TIMEOUT: '40m' }, () => undefined],
      [
        'a private repository',
        {},
        (box) =>
          fs.writeFileSync(
            path.join(box.fixtures, 'visibility-other__repo'),
            'private',
          ),
      ],
      [
        'an API error on the visibility call',
        {},
        (box) =>
          fs.writeFileSync(
            path.join(box.fixtures, 'visibility-acme__target'),
            'ERROR',
          ),
      ],
      ['an empty list', { PROJECTS_RAW: '  ,\n ' }, () => undefined],
      [
        'a malformed entry',
        { PROJECTS_RAW: 'acme/target not-a-repo' },
        () => undefined,
      ],
      ['a traversal entry', { PROJECTS_RAW: 'acme/..' }, () => undefined],
      [
        'more than sixteen repositories',
        {
          PROJECTS_RAW: Array.from({ length: 17 }, (_, i) => `o/r${i}`).join(
            ' ',
          ),
        },
        () => undefined,
      ],
      ['an unset model', { MODEL: '' }, () => undefined],
      ['a malformed model', { MODEL: 'no-provider-slash' }, () => undefined],
      ['a malformed variant', { VARIANT: 'high; rm -rf' }, () => undefined],
    ]
  for (const [label, env, arrange] of failures) {
    it(`fails red before any checkout or write for ${label}`, () => {
      const box = makeBox()
      arrange(box)
      const result = runStep(box, 'prepare', 'Validate configuration', {
        ...CONFIG_ENV,
        ...env,
      })
      expect(result.exitCode).toBe(1)
      expect(result.outputs.has('projects')).toBe(false)
      expect(ghWrites(box)).toEqual([])
      expect(calls(box).filter((line) => line.startsWith('git '))).toEqual([])
    })
  }
})

describe('prepare: finding the open report', () => {
  const find = (box: Box) =>
    runStep(box, 'prepare', 'Find the open report', {
      REPO: 'marcusrbrown/systematic',
    })

  it('treats zero open reports as a first run', () => {
    const box = makeBox()
    writeIssues(box, [{ number: 3, title: 'Unrelated issue' }])
    const result = find(box)
    expect(result.exitCode).toBe(0)
    expect(result.outputs.get('report')).toBe('')
    expect(calls(box).some((line) => /issues\/\d+/.test(line))).toBe(false)
  })

  it('never treats a look-alike as a report', () => {
    const box = makeBox()
    writeIssues(box, [
      { number: 11, title: `${titleOn(DATE_TWO)} extra` },
      { number: 12, title: titleOn(DATE_TWO).replace('—', '-') },
      { number: 13, title: titleOn(DATE_TWO), login: 'someone-else' },
      { number: 14, title: titleOn(DATE_TWO), pr: true },
      { number: 15, title: FRO_BOT_TITLE },
      { number: 16, title: titleOn(DATE_TWO), state: 'closed' },
      { number: 17, title: titleOn(DATE_TWO), login: 'fro-bot' },
      { number: 7, title: titleOn(DATE_ONE) },
    ])
    expect(find(box).outputs.get('report')).toBe('7')
  })

  it('finds no report when the only one with the title was written by fro-bot', () => {
    const box = makeBox()
    writeIssues(box, [
      { number: 20, title: titleOn(DATE_TWO), login: 'fro-bot' },
    ])
    const result = find(box)
    expect(result.exitCode).toBe(0)
    expect(result.outputs.get('report')).toBe('')
  })

  it('picks the newest title date, then the lowest issue number', () => {
    const box = makeBox()
    writeIssues(box, [
      { number: 8, title: titleOn(DATE_ONE) },
      { number: 21, title: titleOn(DATE_TWO) },
      { number: 20, title: titleOn(DATE_TWO), login: 'fro-bot' },
      { number: 22, title: titleOn(DATE_TWO) },
    ])
    const result = find(box)
    expect(result.exitCode).toBe(0)
    expect(result.outputs.get('report')).toBe('21')
  })

  it('writes the chosen body to a file and fails on a lookup error', () => {
    const box = makeBox()
    writeIssues(box, [{ number: 5, title: titleOn(DATE_ONE), body: 'hello' }])
    expect(find(box).outputs.get('report')).toBe('5')
    expect(
      fs
        .readFileSync(path.join(box.tmp, 'report-in', 'body.md'), 'utf8')
        .trim(),
    ).toBe('hello')
    const broken = makeBox()
    writeIssues(broken, [])
    const result = runStep(broken, 'prepare', 'Find the open report', {
      REPO: 'marcusrbrown/systematic',
      GH_FAIL_LIST: '1',
    })
    expect(result.exitCode).toBe(1)
    expect(result.outputs.has('report')).toBe(false)
  })
})

describe('prepare: cache status and state root', () => {
  it('reports whether a cache was restored', () => {
    const box = makeBox()
    runStep(box, 'prepare', 'Create state root')
    const missed = runStep(box, 'prepare', 'Record cache status', {
      CACHE_MATCHED_KEY: '',
    })
    expect(missed.outputs.get('cache-restored')).toBe('false')
    const hit = runStep(box, 'prepare', 'Record cache status', {
      CACHE_MATCHED_KEY: 'connect-v1-1-1',
    })
    expect(hit.outputs.get('cache-restored')).toBe('true')
  })

  it('creates an owner-only state root', () => {
    const box = makeBox()
    expect(runStep(box, 'prepare', 'Create state root').exitCode).toBe(0)
    const mode = fs.statSync(stateRootOf(box)).mode & 0o777
    expect(mode).toBe(0o700)
  })
})

function recordTicks(box: Box, report: number): StepResult {
  return runStep(box, 'prepare', 'Record ticks', {
    REPORT: String(report),
  })
}

function openReport(box: Box, number: number, body: string, date: string) {
  writeIssues(box, [{ number, title: titleOn(date), body }])
  fs.mkdirSync(path.join(box.tmp, 'report-in'), { recursive: true })
  fs.writeFileSync(path.join(box.tmp, 'report-in', 'body.md'), body)
}

/** Lines outside code fences, the way Markdown reads them. */
function outsideFences(body: string): string[] {
  const outside: string[] = []
  let width = 0
  for (const line of body.split('\n')) {
    const fence = /^(`{3,})(.*)$/.exec(line)
    if (width === 0) {
      if (fence === null) outside.push(line)
      else width = fence[1]?.length ?? 0
    } else if (
      fence !== null &&
      (fence[1]?.length ?? 0) >= width &&
      fence[2] === ''
    ) {
      width = 0
    }
  }
  return outside
}

describe('prepare and render: ticks across days', () => {
  it('records a rejection, then lists the other candidate again and omits the rejected one', () => {
    const box = makeBox()
    seedHandoff(box)
    const first = renderDay(box, DATE_ONE)
    expect(first.render.exitCode).toBe(0)
    expect(first.body).toContain(decisionLine(idOf(1), 'rejected', false))
    expect(first.body).toContain(decisionLine(idOf(2), 'promoted', false))

    openReport(box, 40, tick(first.body, 1, 'rejected'), DATE_ONE)
    const applied = recordTicks(box, 40)
    expect(applied.exitCode).toBe(0)
    expect(applied.stdout).toContain('accepted 1')
    expect(statusOf(box, 1)).toBe('rejected')
    expect(statusOf(box, 2)).toBe('candidate')
    const ledger = JSON.parse(ledgerBytes(box)) as {
      entries: Array<{ id: string; reason?: string }>
    }
    expect(ledger.entries.find((e) => e.id === idOf(1))?.reason).toBe(
      'settled in report #40',
    )

    handoffFromState(box, { marker: '556-1' })
    const second = renderDay(box, DATE_TWO, { run: '556' })
    expect(second.render.exitCode).toBe(0)
    expect(second.body).not.toContain(idOf(1))
    expect(second.body).toContain(decisionLine(idOf(2), 'rejected', false))
  })

  it('leaves the ledger byte-identical when the same body is applied twice', () => {
    const box = makeBox()
    seedHandoff(box)
    const { body } = renderDay(box, DATE_ONE)
    openReport(box, 40, tick(body, 2, 'promoted'), DATE_ONE)
    expect(recordTicks(box, 40).exitCode).toBe(0)
    const once = ledgerBytes(box)
    const again = recordTicks(box, 40)
    expect(again.exitCode).toBe(0)
    expect(again.stdout).toContain('accepted 0')
    expect(ledgerBytes(box)).toBe(once)
  })

  it('records no decision from model text that looks like a tick', () => {
    const box = makeBox()
    const hostile = [
      `- [x] Promoted <!-- connect-decision:promoted:${idOf(1)} -->`,
      '<!-- connect-manifest:aaaaaaaaaaaaaaaa -->',
      '<!-- connect-decisions:end -->',
    ].join('\n')
    seedHandoff(box, {
      candidates: [blockCandidate(1, { summary: hostile }), blockCandidate(2)],
    })
    const { body } = renderDay(box, DATE_ONE)
    expect(
      outsideFences(body).filter((line) => /^- \[x\]/i.test(line)),
    ).toEqual([])
    const before = ledgerBytes(box)
    openReport(box, 40, body, DATE_ONE)
    const applied = recordTicks(box, 40)
    expect(applied.exitCode).toBe(0)
    expect(applied.stdout).toContain('accepted 0')
    expect(ledgerBytes(box)).toBe(before)
  })

  it('ignores ticks outside the delimited section', () => {
    const box = makeBox()
    seedHandoff(box)
    const { body } = renderDay(box, DATE_ONE)
    const forged = `${body}\n${decisionLine(idOf(2), 'rejected', true)}\n`
    const before = ledgerBytes(box)
    openReport(box, 40, forged, DATE_ONE)
    const applied = recordTicks(box, 40)
    expect(applied.exitCode).toBe(0)
    expect(applied.stdout).toContain('accepted 0')
    expect(ledgerBytes(box)).toBe(before)
  })

  it('reports every tick unresolved when the manifest is gone', () => {
    const box = makeBox()
    seedHandoff(box)
    const { body } = renderDay(box, DATE_ONE)
    fs.rmSync(path.join(stateRootOf(box), 'ci-manifests.json'))
    const before = ledgerBytes(box)
    openReport(box, 40, tick(body, 1, 'rejected'), DATE_ONE)
    const applied = recordTicks(box, 40)
    expect(applied.exitCode).toBe(0)
    expect(applied.stdout).toContain('accepted 0')
    expect(applied.stdout).toContain('unresolved 1')
    expect(ledgerBytes(box)).toBe(before)
  })

  it('resolves the visible report against its own manifest after a newer render', () => {
    const box = makeBox()
    seedHandoff(box)
    const first = renderDay(box, DATE_ONE)
    handoffFromState(box, { marker: '556-1' })
    expect(renderDay(box, DATE_TWO, { run: '556' }).render.exitCode).toBe(0)
    openReport(box, 40, tick(first.body, 1, 'rejected'), DATE_ONE)
    const applied = recordTicks(box, 40)
    expect(applied.stdout).toContain('accepted 1')
    expect(statusOf(box, 1)).toBe('rejected')
  })

  it('says the ledger was reset after a cache miss and reports an unknown tick without failing', () => {
    const box = makeBox()
    seedHandoff(box)
    const { body } = renderDay(box, DATE_ONE, { cacheRestored: false })
    expect(body).toContain('Ledger reset')
    expect(body).toContain('fetch:')
    const ledger = JSON.parse(ledgerBytes(box)) as {
      version: number
      entries: Array<{ id: string }>
    }
    fs.writeFileSync(
      path.join(stateRootOf(box), 'ledger.json'),
      JSON.stringify({
        ...ledger,
        entries: ledger.entries.filter((entry) => entry.id !== idOf(2)),
      }),
    )
    openReport(box, 40, tick(body, 2, 'rejected'), DATE_ONE)
    const applied = recordTicks(box, 40)
    expect(applied.exitCode).toBe(0)
    expect(applied.stdout).toContain('unresolved 1')
  })

  it('fails when the ledger cannot be read and never replaces it', () => {
    const box = makeBox()
    seedHandoff(box)
    const { body } = renderDay(box, DATE_ONE)
    fs.writeFileSync(path.join(stateRootOf(box), 'ledger.json'), '{not json')
    openReport(box, 40, tick(body, 1, 'rejected'), DATE_ONE)
    expect(recordTicks(box, 40).exitCode).toBe(1)
    expect(ledgerBytes(box)).toBe('{not json')
  })
})

describe('render: hand-off validation', () => {
  const validate = (box: Box) => runStep(box, 'render', 'Validate hand-off')

  it('accepts exactly the allowlisted files and copies them owner-only', () => {
    const box = makeBox()
    seedHandoff(box)
    expect(validate(box).exitCode).toBe(0)
    const root = stateRootOf(box)
    expect(fs.existsSync(path.join(root, 'ledger.json'))).toBe(true)
    expect(fs.statSync(path.join(root, 'ledger.json')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(root).mode & 0o777).toBe(0o700)
  })

  const hostile: Array<[string, (dir: string) => void]> = [
    [
      'a symlink',
      (dir) => fs.symlinkSync('/etc/hosts', path.join(dir, 'digest.md')),
    ],
    [
      'a symlinked allowlisted name',
      (dir) => fs.symlinkSync('/etc/hosts', path.join(dir, 'ci-payloads.json')),
    ],
    [
      'a report file',
      (dir) => fs.writeFileSync(path.join(dir, 'report.md'), 'x'),
    ],
    [
      'the run marker file',
      (dir) => fs.writeFileSync(path.join(dir, 'ci-run.json'), 'x'),
    ],
    [
      'a lock directory',
      (dir) => {
        fs.mkdirSync(path.join(dir, 'lock'))
        fs.writeFileSync(path.join(dir, 'lock', 'holder.json'), '{}')
      },
    ],
    [
      'a file at an unexpected depth',
      (dir) => {
        fs.mkdirSync(path.join(dir, 'runs', 'a', 'b'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'runs', 'a', 'b', 'run.json'), '{}')
      },
    ],
    [
      'an unexpected file in a run directory',
      (dir) => {
        fs.mkdirSync(path.join(dir, 'runs', 'a'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'runs', 'a', 'token.txt'), 'secret')
      },
    ],
    [
      'an oversize file',
      (dir) =>
        fs.writeFileSync(
          path.join(dir, 'ledger.json'),
          Buffer.alloc(21 * 1024 * 1024),
        ),
    ],
  ]
  for (const [label, arrange] of hostile) {
    it(`fails before copying anything when the hand-off holds ${label}`, () => {
      const box = makeBox()
      const dir = seedHandoff(box)
      arrange(dir)
      const result = validate(box)
      expect(result.exitCode).toBe(1)
      expect(fs.existsSync(path.join(stateRootOf(box), 'ledger.json'))).toBe(
        false,
      )
    })
  }
})

describe('render: outcomes and failures', () => {
  const outcomes: Array<[string, Json, boolean, RegExp]> = [
    ['complete', {}, false, /Connect complete/],
    [
      'degraded',
      { outcome: 'degraded', finalLine: 'Connect degraded' },
      false,
      /Connect degraded/,
    ],
    [
      'busy',
      {
        outcome: 'busy',
        finalLine: 'Connect busy',
        runId: undefined,
        projects: undefined,
      },
      false,
      /Connect busy/,
    ],
    [
      'failed',
      {
        outcome: 'failed',
        finalLine: 'Connect failed',
        reason: 'unsupported-host',
      },
      true,
      /Connect failed/,
    ],
    [
      'begun with no terminal record',
      { phase: 'begun', outcome: undefined, finalLine: undefined },
      true,
      /ended with no final line/,
    ],
  ]
  for (const [label, invocation, red, sentence] of outcomes) {
    it(`posts a ${label} run as itself and ${red ? 'turns the job red' : 'stays green'}`, () => {
      const box = makeBox()
      seedHandoff(box, { invocation })
      const { render, body } = renderDay(box, DATE_ONE)
      expect(render.exitCode).toBe(0)
      expect(render.outputs.get('red')).toBe(String(red))
      expect(body).toMatch(sentence)
      const done = finalize(box, render)
      expect(done.outputs.get('has-body')).toBe('true')
      expect(done.outputs.get('red')).toBe(String(red))
    })
  }

  it('fails with nothing posted when no run record carries this run marker', () => {
    for (const invocation of [null, { marker: '554-1' }]) {
      const box = makeBox()
      seedHandoff(box, { invocation })
      const { render, body } = renderDay(box, DATE_ONE)
      expect(render.exitCode).toBe(1)
      expect(render.stderr + render.stdout).toContain('no-invocation')
      expect(body).toBe('')
    }
  })

  it('fails with nothing posted when a store cannot be read', () => {
    const box = makeBox()
    const dir = seedHandoff(box)
    fs.writeFileSync(path.join(dir, 'ci-payloads.json'), '{not json')
    const { render, body } = renderDay(box, DATE_ONE)
    expect(render.exitCode).toBe(1)
    expect(render.stderr + render.stdout).toContain('payload-store-unreadable')
    expect(body).toBe('')
    const second = makeBox()
    const dirTwo = seedHandoff(second)
    fs.writeFileSync(path.join(dirTwo, 'ci-manifests.json'), '[1,2')
    const renderedTwo = renderDay(second, DATE_ONE).render
    expect(renderedTwo.exitCode).toBe(1)
    expect(renderedTwo.stdout).toContain('manifest-store-unreadable')
  })

  it('stops on a report date or cache status with an unexpected shape', () => {
    const box = makeBox()
    seedHandoff(box)
    runStep(box, 'render', 'Validate hand-off')
    runStep(box, 'render', 'Install helper')
    expect(
      runStep(box, 'render', 'Render report', {
        DATE: '2026-02-31x',
        CACHE_RESTORED: 'true',
      }).exitCode,
    ).toBe(1)
    expect(
      runStep(box, 'render', 'Render report', {
        DATE: DATE_ONE,
        CACHE_RESTORED: 'maybe',
      }).exitCode,
    ).toBe(1)
  })
})

describe('render: finalizing and the run record', () => {
  it('appends the fixed line before computing the digest when the cache save failed', () => {
    const box = makeBox()
    seedHandoff(box)
    const { render } = renderDay(box, DATE_ONE)
    const bodyFile = path.join(box.tmp, 'report', 'body.md')
    const plain = fs.readFileSync(bodyFile, 'utf8')
    const done = finalize(box, render, 'failure')
    const body = fs.readFileSync(bodyFile, 'utf8')
    expect(body.startsWith(plain)).toBe(true)
    expect(body).toContain('The ledger cache could not be saved for this run')
    expect(done.outputs.get('red')).toBe('true')
    expect(done.outputs.get('digest')).toBe(sha(body))
    expect(done.outputs.get('chars')).toBe(String(body.length))
    const envelope = JSON.parse(
      fs.readFileSync(path.join(box.tmp, 'report', 'envelope.json'), 'utf8'),
    ) as Json
    expect(envelope).toMatchObject({ red: true, cacheSaved: false })
  })

  it('leaves the body alone when the cache saved', () => {
    const box = makeBox()
    seedHandoff(box)
    const { render } = renderDay(box, DATE_ONE)
    const bodyFile = path.join(box.tmp, 'report', 'body.md')
    const plain = fs.readFileSync(bodyFile, 'utf8')
    const done = finalize(box, render, 'success')
    expect(fs.readFileSync(bodyFile, 'utf8')).toBe(plain)
    expect(done.outputs.get('red')).toBe('false')
    expect(done.outputs.get('digest')).toBe(sha(plain))
  })

  it('stages the run record alone, and nothing when the run made none', () => {
    const box = makeBox()
    seedHandoff(box)
    renderDay(box, DATE_ONE)
    const staged = runStep(box, 'render', 'Stage run record')
    expect(staged.outputs.get('has-record')).toBe('true')
    expect(fs.readdirSync(path.join(box.tmp, 'public'))).toEqual(['run.json'])
    expect(
      JSON.parse(
        fs.readFileSync(path.join(box.tmp, 'public', 'run.json'), 'utf8'),
      ),
    ).toMatchObject({ runId: CONNECT_RUN })

    const busy = makeBox()
    seedHandoff(busy, {
      invocation: {
        outcome: 'busy',
        finalLine: 'Connect busy',
        runId: undefined,
        projects: undefined,
      },
    })
    renderDay(busy, DATE_ONE)
    expect(
      runStep(busy, 'render', 'Stage run record').outputs.get('has-record'),
    ).toBe('false')
    expect(fs.existsSync(path.join(busy.tmp, 'public'))).toBe(false)

    const linked = makeBox()
    seedHandoff(linked)
    renderDay(linked, DATE_ONE)
    const record = path.join(
      stateRootOf(linked),
      'runs',
      CONNECT_RUN,
      'run.json',
    )
    fs.rmSync(record)
    fs.symlinkSync('/etc/hosts', record)
    expect(
      runStep(linked, 'render', 'Stage run record').outputs.get('has-record'),
    ).toBe('false')
  })
})

// ── Run job ─────────────────────────────────────────────────────────────────

const RUN_ROOT = (box: Box): string =>
  path.join(box.ws, 'connect', 'state', 'systematic', 'connect')

const RUN_PROJECTS = 'acme/target other/repo'

function layoutBox(): Box {
  const box = makeBox()
  expect(runStep(box, 'run', 'Create connect layout').exitCode).toBe(0)
  return box
}

describe('run job: layout, config and marker', () => {
  it('creates an owner-only state root inside the workspace and exports it for the agent', () => {
    const box = layoutBox()
    expect(fs.statSync(RUN_ROOT(box)).mode & 0o777).toBe(0o700)
    expect(fs.existsSync(path.join(box.ws, 'connect', 'checkouts'))).toBe(true)
    expect(fs.readFileSync(box.githubEnv, 'utf8')).toBe(
      `XDG_STATE_HOME=${path.join(box.ws, 'connect', 'state')}\n`,
    )
    expect(
      calls(box).some((line) =>
        line.startsWith('git config --global user.name'),
      ),
    ).toBe(true)
    expect(
      calls(box).some((line) =>
        line.startsWith('git config --global user.email'),
      ),
    ).toBe(true)
  })

  it('writes the run marker file the helper reads, and drops the hand-off marker', () => {
    const box = layoutBox()
    fs.writeFileSync(path.join(RUN_ROOT(box), 'handoff.json'), '{"version":1}')
    expect(runStep(box, 'run', 'Write run marker').exitCode).toBe(0)
    expect(
      JSON.parse(
        fs.readFileSync(path.join(RUN_ROOT(box), 'ci-run.json'), 'utf8'),
      ),
    ).toEqual({ version: 1, marker: '555-1' })
    expect(fs.existsSync(path.join(RUN_ROOT(box), 'handoff.json'))).toBe(false)
    expect(readCiRunMarker(RUN_ROOT(box))).toBe('555-1')
    expect(
      fs.statSync(path.join(RUN_ROOT(box), 'ci-run.json')).mode & 0o777,
    ).toBe(0o600)
  })

  it('clones each project from its public URL, without credentials, under the checkouts directory', () => {
    const box = layoutBox()
    const result = runStep(box, 'run', 'Clone projects', {
      PROJECTS: RUN_PROJECTS,
    })
    expect(result.exitCode).toBe(0)
    const clones = calls(box).filter((line) => line.includes(' clone '))
    expect(clones).toHaveLength(2)
    expect(clones[0]).toContain('https://github.com/acme/target.git')
    expect(clones[0]).toContain(
      path.join(box.ws, 'connect', 'checkouts', 'acme__target'),
    )
    expect(clones.join('\n')).not.toMatch(/@github\.com|token|x-access/)
    expect(
      fs.existsSync(
        path.join(box.ws, 'connect', 'checkouts', 'other__repo', '.git'),
      ),
    ).toBe(true)
  })

  it('refuses a malformed project', () => {
    const box = layoutBox()
    expect(
      runStep(box, 'run', 'Clone projects', { PROJECTS: 'acme/target ../x' })
        .exitCode,
    ).toBe(1)
  })

  it('writes the allow list and the researcher model overlay to the runner config', () => {
    const box = layoutBox()
    const result = runStep(box, 'run', 'Write runner config', {
      PROJECTS: RUN_PROJECTS,
      MODEL: 'anthropic/claude-sonnet-5-5',
      VARIANT: 'high',
    })
    expect(result.exitCode).toBe(0)
    const file = path.join(box.home, '.config', 'opencode', 'systematic.jsonc')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      connect: {
        allow_projects: [
          path.join(box.ws, 'connect', 'checkouts', 'acme__target'),
          path.join(box.ws, 'connect', 'checkouts', 'other__repo'),
        ],
      },
      agents: {
        'connections-researcher': {
          model: 'anthropic/claude-sonnet-5-5',
          variant: 'high',
        },
      },
    })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('leaves the variant out when none is set', () => {
    const box = layoutBox()
    runStep(box, 'run', 'Write runner config', {
      PROJECTS: RUN_PROJECTS,
      MODEL: 'anthropic/claude-sonnet-5-5',
      VARIANT: '',
    })
    const file = path.join(box.home, '.config', 'opencode', 'systematic.jsonc')
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      agents: { 'connections-researcher': Json }
    }
    expect(config.agents['connections-researcher']).toEqual({
      model: 'anthropic/claude-sonnet-5-5',
    })
  })
})

// ── The checkout of the shared agent action ─────────────────────────────────

/** Real git, with no user or system configuration. */
function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: cwd,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  }
}

/** Every file under `dir` except the `.git` directory, relative and sorted. */
function filesUnder(dir: string): string[] {
  return [...new Bun.Glob('**/*').scanSync({ cwd: dir, dot: true })]
    .filter((file) => file !== '.git' && !file.startsWith('.git/'))
    .sort()
}

describe('run job: the checkout of the shared agent action', () => {
  const checkout = () => stepNamed('run', CHECKOUT_STEP)

  it('is sparse, takes no credentials and leaves what is already in the workspace alone', () => {
    expect(String(checkout().uses)).toMatch(/^actions\/checkout@[0-9a-f]{40}$/)
    // The job token is the default, and so is the ref: this repository, at the
    // commit the run started from.
    expect(asRecord(checkout().with, 'checkout with')).toEqual({
      path: '.fro-bot-actions',
      'sparse-checkout': '/.github/actions/\n',
      'sparse-checkout-cone-mode': false,
      'persist-credentials': false,
      clean: false,
    })
  })

  it('runs before the layout is created', () => {
    expect(stepIndex('run', CHECKOUT_STEP)).toBeGreaterThan(-1)
    expect(stepIndex('run', CHECKOUT_STEP)).toBeLessThan(
      stepIndex('run', 'Create connect layout'),
    )
  })

  describe('the sparse patterns', () => {
    /** A repository with files at the root, in `.github` and elsewhere. */
    function sourceRepository(): string {
      const dir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'connect-sparse-')),
      )
      dirs.push(dir)
      const repo = path.join(dir, 'origin')
      const files = [
        'README.md',
        'package.json',
        'src/index.ts',
        'skills/ce-connect/SKILL.md',
        '.github/CODEOWNERS',
        '.github/workflows/connect.yaml',
        '.github/actions/fro-bot-agent/action.yml',
        '.github/actions/other/nested/deep.yml',
      ]
      fs.mkdirSync(repo)
      git(repo, 'init', '--quiet')
      for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
        fs.writeFileSync(path.join(repo, file), `${file}\n`)
      }
      git(repo, 'add', '.')
      git(repo, 'commit', '--quiet', '-m', 'seed')
      return repo
    }

    /** What `actions/checkout` does for a non-cone sparse checkout, step for step. */
    function checkOut(origin: string, patterns: string, cone: boolean): string {
      const work = path.join(path.dirname(origin), 'work')
      git(
        path.dirname(origin),
        'clone',
        '--quiet',
        '--no-checkout',
        origin,
        work,
      )
      if (cone) {
        git(work, 'sparse-checkout', 'set', ...patterns.trim().split('\n'))
      } else {
        git(work, 'config', 'core.sparseCheckout', 'true')
        fs.appendFileSync(
          path.join(work, '.git', 'info', 'sparse-checkout'),
          `\n${patterns}\n`,
        )
      }
      git(work, 'checkout', '--quiet', '--force', 'HEAD')
      return work
    }

    const patterns = () =>
      asString(withOf('run', CHECKOUT_STEP)['sparse-checkout'], 'patterns')

    it('lay down nothing but the files under .github/actions', () => {
      const work = checkOut(sourceRepository(), patterns(), false)
      expect(filesUnder(work)).toEqual([
        '.github/actions/fro-bot-agent/action.yml',
        '.github/actions/other/nested/deep.yml',
      ])
    })

    it('would lay down the files at the root in cone mode, which is why the step turns it off', () => {
      const work = checkOut(sourceRepository(), '.github/actions\n', true)
      expect(filesUnder(work)).toContain('package.json')
      expect(withOf('run', CHECKOUT_STEP)['sparse-checkout-cone-mode']).toBe(
        false,
      )
    })
  })

  describe('beside the state root', () => {
    const checkoutPath = () =>
      asString(withOf('run', CHECKOUT_STEP).path, 'checkout path')
    const allowedRoots = (box: Box) => [
      path.join(box.ws, 'connect', 'checkouts', 'acme__target'),
    ]

    it('leaves the state root acceptable to the helper', () => {
      const box = makeBox()
      git(box.dir, 'init', '--quiet', path.join(box.ws, checkoutPath()))
      expect(runStep(box, 'run', 'Create connect layout').exitCode).toBe(0)
      expect(
        fs.existsSync(path.join(box.ws, checkoutPath(), '.git', 'HEAD')),
      ).toBe(true)
      expect(
        prepareStateRoot(RUN_ROOT(box), { allowedRoots: allowedRoots(box) }),
      ).toEqual({ status: 'ok', root: RUN_ROOT(box), tightened: false })
    })

    it('would be refused by the helper if the checkout were the workspace itself', () => {
      const box = makeBox()
      git(box.dir, 'init', '--quiet', box.ws)
      expect(runStep(box, 'run', 'Create connect layout').exitCode).toBe(0)
      expect(
        prepareStateRoot(RUN_ROOT(box), { allowedRoots: allowedRoots(box) }),
      ).toEqual({ status: 'refused', reason: 'checkout' })
      expect(checkoutPath()).not.toBe('')
      expect(checkoutPath()).not.toBe('.')
    })
  })
})

describe('run job: reading the run record', () => {
  const projectsOf = (...repos: string[]) =>
    repos.map((repo, index) => ({
      key: `${index}`.padStart(12, 'a'),
      name: repo.split('/')[1],
      repo,
    }))

  function recordBox(record: Json | null): Box {
    const box = layoutBox()
    if (record !== null) {
      writeJson(path.join(RUN_ROOT(box), 'invocation.json'), {
        version: 1,
        marker: '555-1',
        phase: 'terminal',
        outcome: 'complete',
        finalLine: 'Connect complete',
        runId: CONNECT_RUN,
        projects: projectsOf('acme/target', 'other/repo'),
        ...record,
      })
    }
    return box
  }

  const read = (box: Box, agent = 'success') =>
    runStep(box, 'run', 'Read run record', {
      PROJECTS: RUN_PROJECTS,
      AGENT_OUTCOME: agent,
    })

  it('accepts a record with this run marker whose projects match the allow list', () => {
    const result = read(recordBox({}))
    expect(result.exitCode).toBe(0)
    expect(result.outputs.get('accepted')).toBe('true')
  })

  it('accepts a begun record as a run with no final line, even after the agent step failed', () => {
    const box = recordBox({
      phase: 'begun',
      outcome: undefined,
      finalLine: undefined,
    })
    const result = read(box, 'failure')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('no-final-line')
  })

  it('accepts a terminal record that resolved no projects', () => {
    const box = recordBox({
      outcome: 'failed',
      finalLine: 'Connect failed',
      projects: undefined,
    })
    expect(read(box).outputs.get('accepted')).toBe('true')
  })

  it('fails red with nothing accepted when no record exists', () => {
    const result = read(recordBox(null), 'failure')
    expect(result.exitCode).toBe(1)
    expect(result.outputs.has('accepted')).toBe(false)
  })

  it('does not take an older record or an older run directory for this run', () => {
    const box = recordBox({ marker: '554-1' })
    writeJson(path.join(RUN_ROOT(box), 'runs', CONNECT_RUN, 'run.json'), {
      schemaVersion: 1,
    })
    const result = read(box)
    expect(result.exitCode).toBe(1)
    expect(result.outputs.has('accepted')).toBe(false)
  })

  it('fails red when the resolved projects differ from the allow list that was written', () => {
    for (const projects of [
      projectsOf('acme/target'),
      projectsOf('acme/target', 'other/repo', 'extra/one'),
      projectsOf('acme/target', 'someone/else'),
      [{ key: 'a'.repeat(12), name: 'target' }],
    ]) {
      const result = read(recordBox({ projects }))
      expect(result.exitCode).toBe(1)
      expect(result.outputs.has('accepted')).toBe(false)
    }
  })

  it('refuses a symlinked or oversize record', () => {
    const linked = recordBox(null)
    fs.symlinkSync('/etc/hosts', path.join(RUN_ROOT(linked), 'invocation.json'))
    expect(read(linked).exitCode).toBe(1)
    const big = recordBox(null)
    fs.writeFileSync(
      path.join(RUN_ROOT(big), 'invocation.json'),
      Buffer.alloc(1024 * 1024 + 1),
    )
    expect(read(big).exitCode).toBe(1)
  })

  it('drops symlinks from the state root before the upload follows them', () => {
    const box = recordBox({})
    fs.symlinkSync('/etc/hosts', path.join(RUN_ROOT(box), 'ledger.json'))
    expect(runStep(box, 'run', 'Drop symlinks from state').exitCode).toBe(0)
    expect(fs.existsSync(path.join(RUN_ROOT(box), 'ledger.json'))).toBe(false)
    expect(fs.existsSync(path.join(RUN_ROOT(box), 'invocation.json'))).toBe(
      true,
    )
  })
})

// ── Post job ────────────────────────────────────────────────────────────────

const MARKER_LINE = manifestMarker('0123456789abcdef')

function reportBody(size = 400): string {
  return `## ce:connect report\n\n${MARKER_LINE}\n${'x'.repeat(Math.max(0, size - 60))}\n`
}

function postEnv(
  box: Box,
  body: string,
  date = DATE_ONE,
): Record<string, string> {
  fs.mkdirSync(path.join(box.tmp, 'report'), { recursive: true })
  fs.writeFileSync(path.join(box.tmp, 'report', 'body.md'), body)
  return {
    DATE: date,
    RENDER_DIGEST: sha(body),
    RENDER_CHARS: String(body.length),
    REPO: 'marcusrbrown/systematic',
  }
}

/** The job installs the tick carrier before the steps that use it; do the same, once per box. */
function ensureCarrier(box: Box): void {
  if (fs.existsSync(path.join(box.tmp, 'carry-ticks.mjs'))) return
  const installed = runStep(box, 'post', 'Install tick carrier')
  expect(installed.stderr).toBe('')
  expect(installed.exitCode).toBe(0)
}

const post = (box: Box, name: string, env: Record<string, string> = {}) => {
  if (name === 'Write report' || name === 'Close superseded reports') {
    ensureCarrier(box)
  }
  return runStep(box, 'post', name, { REPO: 'marcusrbrown/systematic', ...env })
}

describe('post: verifying the report', () => {
  it('accepts a body at the renderer cap and refuses one above the posting cap', () => {
    const ok = makeBox()
    expect(
      post(ok, 'Verify report', postEnv(ok, reportBody(60_000))).exitCode,
    ).toBe(0)
    const over = makeBox()
    const result = post(
      over,
      'Verify report',
      postEnv(over, reportBody(60_501)),
    )
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('size cap')
  })

  it('refuses a body that does not match its digest or size', () => {
    const box = makeBox()
    const env = postEnv(box, reportBody())
    const bodyFile = path.join(box.tmp, 'report', 'body.md')
    const original = fs.readFileSync(bodyFile, 'utf8')
    // Same length, different text: only the digest can tell.
    fs.writeFileSync(
      bodyFile,
      original.replace('## ce:connect', '## ce:CONNECT'),
    )
    expect(post(box, 'Verify report', env).exitCode).toBe(1)
    expect(post(box, 'Verify report', env).stdout).toContain('digest')
    fs.appendFileSync(bodyFile, 'longer')
    expect(post(box, 'Verify report', env).exitCode).toBe(1)
    const sized = makeBox()
    const sizedEnv = postEnv(sized, reportBody())
    expect(
      post(sized, 'Verify report', { ...sizedEnv, RENDER_CHARS: '3' }).exitCode,
    ).toBe(1)
  })

  it('refuses a malformed digest, size or date, a symlinked body and a missing body', () => {
    const box = makeBox()
    const env = postEnv(box, reportBody())
    const malformed: Array<Record<string, string>> = [
      { RENDER_DIGEST: 'xyz' },
      { RENDER_CHARS: '12x' },
      { DATE: '2026-13-45' },
    ]
    for (const bad of malformed) {
      expect(post(box, 'Verify report', { ...env, ...bad }).exitCode).toBe(1)
    }
    const body = path.join(box.tmp, 'report', 'body.md')
    fs.rmSync(body)
    expect(post(box, 'Verify report', env).exitCode).toBe(1)
    fs.symlinkSync('/etc/hosts', body)
    expect(post(box, 'Verify report', env).exitCode).toBe(1)
  })
})

describe('post: visibility recheck', () => {
  it('stops before any write when a repository turned private or cannot be read', () => {
    for (const verdict of ['private', 'ERROR']) {
      const box = makeBox()
      fs.writeFileSync(
        path.join(box.fixtures, 'visibility-other__repo'),
        verdict,
      )
      const result = post(box, 'Recheck visibility', { PROJECTS: RUN_PROJECTS })
      expect(result.exitCode).toBe(1)
      expect(ghWrites(box)).toEqual([])
    }
  })

  it('passes when every repository is still public', () => {
    const box = makeBox()
    expect(
      post(box, 'Recheck visibility', { PROJECTS: RUN_PROJECTS }).exitCode,
    ).toBe(0)
  })
})

describe('post: writing and rotating the report', () => {
  const write = (box: Box, date = DATE_ONE) =>
    post(box, 'Write report', postEnv(box, reportBody(), date))
  const rotate = (box: Box, number: string) =>
    post(box, 'Close superseded reports', { NUMBER: number })
  const creates = (box: Box) =>
    calls(box).filter((line) => /-X POST repos\/[^ ]+\/issues /.test(line))
  const edits = (box: Box) =>
    calls(box).filter((line) =>
      /-X PATCH repos\/[^ ]+\/issues\/\d+ -f title/.test(line),
    )

  it("edits that day's report in place by number and opens no second issue", () => {
    const box = makeBox()
    writeIssues(box, [{ number: 42, title: titleOn(DATE_ONE), body: 'old' }])
    const result = write(box)
    expect(result.exitCode).toBe(0)
    expect(result.outputs.get('number')).toBe('42')
    expect(creates(box)).toEqual([])
    expect(edits(box)).toHaveLength(1)
    expect(issuesOf(box)[0]?.body).toContain(MARKER_LINE)
    expect(rotate(box, '42').exitCode).toBe(0)
    expect(issuesOf(box).filter((i) => i.state === 'open')).toHaveLength(1)
  })

  it("creates a new date's report, confirms it, and only then closes the previous one", () => {
    const box = makeBox()
    writeIssues(box, [{ number: 7, title: titleOn(DATE_ONE) }])
    const written = write(box, DATE_TWO)
    expect(written.exitCode).toBe(0)
    const number = written.outputs.get('number') ?? ''
    expect(rotate(box, number).exitCode).toBe(0)
    const log = calls(box)
    const created = log.findIndex((line) =>
      /-X POST repos\/[^ ]+\/issues /.test(line),
    )
    const readBack = log.findIndex(
      (line, index) => index > created && line.endsWith(`issues/${number}`),
    )
    const comment = log.findIndex((line) => line.includes('issues/7/comments'))
    const closed = log.findIndex((line) =>
      /-X PATCH repos\/[^ ]+\/issues\/7 .*state=closed/.test(line),
    )
    expect(created).toBeGreaterThan(-1)
    expect(readBack).toBeGreaterThan(created)
    expect(comment).toBeGreaterThan(readBack)
    expect(closed).toBeGreaterThan(comment)
    const issues = issuesOf(box)
    expect(issues.find((i) => i.number === 7)?.state).toBe('closed')
    expect(issues.find((i) => i.number === Number(number))?.state).toBe('open')
  })

  it('creates the first report and has nothing to close', () => {
    const box = makeBox()
    writeIssues(box, [])
    const written = write(box)
    expect(written.exitCode).toBe(0)
    expect(rotate(box, written.outputs.get('number') ?? '').exitCode).toBe(0)
    expect(calls(box).filter((line) => line.includes('state=closed'))).toEqual(
      [],
    )
  })

  it('never closes a look-alike, a pull request or a closed issue', () => {
    const box = makeBox()
    writeIssues(box, [
      { number: 30, title: `${titleOn(DATE_ONE)} extra` },
      { number: 31, title: titleOn(DATE_ONE), login: 'someone-else' },
      { number: 32, title: titleOn(DATE_ONE), pr: true },
      { number: 33, title: FRO_BOT_TITLE, login: 'fro-bot' },
      { number: 34, title: titleOn(DATE_ONE), login: 'fro-bot' },
      { number: 7, title: titleOn(DATE_ONE) },
    ])
    const written = write(box, DATE_TWO)
    expect(rotate(box, written.outputs.get('number') ?? '').exitCode).toBe(0)
    const open = issuesOf(box)
      .filter((i) => i.state === 'open')
      .map((i) => i.number)
    expect(open).toEqual(expect.arrayContaining([30, 31, 32, 33, 34]))
    expect(open).not.toContain(7)
  })

  it('edits the lowest-numbered report of the date and closes the other duplicates', () => {
    const box = makeBox()
    writeIssues(box, [
      { number: 51, title: titleOn(DATE_ONE) },
      { number: 50, title: titleOn(DATE_ONE) },
    ])
    const written = write(box)
    expect(written.outputs.get('number')).toBe('50')
    expect(rotate(box, '50').exitCode).toBe(0)
    const issues = issuesOf(box)
    expect(issues.find((i) => i.number === 50)?.state).toBe('open')
    expect(issues.find((i) => i.number === 51)?.state).toBe('closed')
  })

  it('opens its own report for the date rather than editing a same-date report that fro-bot wrote', () => {
    const box = makeBox()
    writeIssues(box, [
      {
        number: 50,
        title: titleOn(DATE_ONE),
        body: 'theirs',
        login: 'fro-bot',
      },
    ])
    const written = write(box)
    expect(written.exitCode).toBe(0)
    expect(Number(written.outputs.get('number'))).toBeGreaterThan(50)
    expect(edits(box)).toEqual([])
    expect(issuesOf(box).find((i) => i.number === 50)?.body).toBe('theirs')
  })

  it('refuses to rotate when the report did not read back as written by an expected author', () => {
    const box = makeBox()
    writeIssues(box, [{ number: 7, title: titleOn(DATE_ONE) }])
    const result = post(box, 'Write report', {
      ...postEnv(box, reportBody(), DATE_TWO),
      GH_ACTOR: 'mallory',
    })
    expect(result.exitCode).toBe(1)
    expect(result.outputs.has('number')).toBe(false)
    expect(issuesOf(box).find((i) => i.number === 7)?.state).toBe('open')
  })

  it('refuses to rotate when the report reads back as written by fro-bot', () => {
    const box = makeBox()
    writeIssues(box, [{ number: 7, title: titleOn(DATE_ONE) }])
    const result = post(box, 'Write report', {
      ...postEnv(box, reportBody(), DATE_TWO),
      GH_ACTOR: 'fro-bot',
    })
    expect(result.exitCode).toBe(1)
    expect(result.outputs.has('number')).toBe(false)
    expect(issuesOf(box).find((i) => i.number === 7)?.state).toBe('open')
  })

  it('fails before the write when the issue list cannot be read', () => {
    const box = makeBox()
    writeIssues(box, [])
    const result = post(box, 'Write report', {
      ...postEnv(box, reportBody()),
      GH_FAIL_LIST: '1',
    })
    expect(result.exitCode).toBe(1)
    expect(ghWrites(box)).toEqual([])
  })

  it('leaves two reports open after a rotation failure, and the next run picks the newest and closes both', () => {
    const box = makeBox()
    writeIssues(box, [{ number: 10, title: titleOn(DATE_ONE) }])
    const written = write(box, DATE_TWO)
    const number = written.outputs.get('number') ?? ''
    const failed = post(box, 'Close superseded reports', {
      NUMBER: number,
      GH_FAIL_AT: 'state=closed',
    })
    expect(failed.exitCode).toBe(1)
    expect(issuesOf(box).filter((i) => i.state === 'open')).toHaveLength(2)

    const found = runStep(box, 'prepare', 'Find the open report', {
      REPO: 'marcusrbrown/systematic',
    })
    expect(found.outputs.get('report')).toBe(number)

    const next = write(box, '2026-11-14')
    expect(rotate(box, next.outputs.get('number') ?? '').exitCode).toBe(0)
    const open = issuesOf(box).filter((i) => i.state === 'open')
    expect(open.map((i) => i.title)).toEqual([titleOn('2026-11-14')])
  })

  it('turns the workflow red only when the render outputs say so', () => {
    const box = makeBox()
    expect(
      runStep(box, 'post', 'Settle result', { RENDER_RED: 'false' }).exitCode,
    ).toBe(0)
    expect(
      runStep(box, 'post', 'Settle result', { RENDER_RED: 'true' }).exitCode,
    ).toBe(1)
  })
})

// ── An agent step cut off by its timeout ────────────────────────────────────

// A step that hits `timeout-minutes` ends with the outcome `failure`; with
// `continue-on-error` the job goes on. The steps after it see a failed agent
// step and whatever record ce:connect left.
describe('agent step timeout after ce:connect began', () => {
  const AGENT_OUTCOME = 'failure'

  it('is accepted by the run job, rendered as a run with no final line, posted and then settled red', () => {
    const runBox = layoutBox()
    writeJson(path.join(RUN_ROOT(runBox), 'invocation.json'), {
      version: 1,
      marker: '555-1',
      phase: 'begun',
      runId: CONNECT_RUN,
      projects: [{ key: PROJECT_KEY, name: 'target', repo: 'acme/target' }],
    })
    const accepted = runStep(runBox, 'run', 'Read run record', {
      PROJECTS: 'acme/target',
      AGENT_OUTCOME,
    })
    expect(accepted.exitCode).toBe(0)
    expect(accepted.outputs.get('accepted')).toBe('true')
    expect(accepted.stdout).toContain('no-final-line')
    expect(accepted.stdout).toContain(`agent step: ${AGENT_OUTCOME}`)

    // What the run job uploads is what the render job reads.
    const record = JSON.parse(
      fs.readFileSync(path.join(RUN_ROOT(runBox), 'invocation.json'), 'utf8'),
    ) as Json
    const box = makeBox()
    seedHandoff(box, {
      invocation: { ...record, outcome: undefined, finalLine: undefined },
    })
    const { render, body } = renderDay(box, DATE_ONE)
    expect(render.exitCode).toBe(0)
    expect(body).toMatch(/ended with no final line/)
    const done = finalize(box, render)
    expect(done.outputs.get('has-body')).toBe('true')
    expect(done.outputs.get('red')).toBe('true')

    writeIssues(box, [])
    const env = {
      DATE: DATE_ONE,
      RENDER_DIGEST: done.outputs.get('digest') ?? '',
      RENDER_CHARS: done.outputs.get('chars') ?? '',
    }
    expect(post(box, 'Verify report', env).exitCode).toBe(0)
    const written = post(box, 'Write report', env)
    expect(written.exitCode).toBe(0)
    expect(
      post(box, 'Close superseded reports', {
        NUMBER: written.outputs.get('number') ?? '',
      }).exitCode,
    ).toBe(0)
    const issues = issuesOf(box)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.title).toBe(titleOn(DATE_ONE))
    expect(issues[0]?.body).toMatch(/ended with no final line/)

    const settled = post(box, 'Settle result', {
      RENDER_RED: done.outputs.get('red') ?? '',
    })
    expect(settled.exitCode).toBe(1)
  })

  it('fails the run job red with nothing accepted when the agent was cut off before ce:connect began', () => {
    const box = layoutBox()
    const result = runStep(box, 'run', 'Read run record', {
      PROJECTS: 'acme/target',
      AGENT_OUTCOME,
    })
    expect(result.exitCode).toBe(1)
    expect(result.outputs.has('accepted')).toBe(false)
    expect(result.stdout).toContain(`agent step: ${AGENT_OUTCOME}`)
  })
})

// ── Job conditions, artifact names and the cache check ─────────────────────

interface NeedsFixture {
  result: string
  outputs?: Record<string, string>
}

/** Evaluate a job's `if` against the results of the jobs it needs. Only the terms the workflow uses are understood. */
function jobRuns(
  id: JobId,
  needs: Record<string, NeedsFixture>,
  ref = 'refs/heads/main',
): boolean {
  const terms = asString(job(id).if, `${id} if`)
    .split('&&')
    .map((term) => term.trim())
  return terms.every((term) => {
    if (term === 'always()') return true
    if (term === GUARD) return ref === 'refs/heads/main'
    const match =
      /^needs\.([a-z]+)\.(result|outputs\.[a-z-]+) == '([^']*)'$/.exec(term)
    if (match === null) throw new Error(`unsupported condition: ${term}`)
    const [, name = '', field = '', expected] = match
    const entry = needs[name]
    const actual =
      field === 'result'
        ? entry?.result
        : entry?.outputs?.[field.slice('outputs.'.length)]
    return actual === expected
  })
}

/** Fill in `${{ needs.<job>.outputs.<name> }}` the way the runner does. */
function resolveNeeds(
  text: string,
  needs: Record<string, NeedsFixture>,
): string {
  return text.replace(
    /\$\{\{ needs\.([a-z]+)\.outputs\.([a-z-]+) \}\}/g,
    (_whole, name: string, output: string) =>
      needs[name]?.outputs?.[output] ?? '',
  )
}

describe('artifact hand-offs when only the failed jobs are rerun', () => {
  const producers: Array<[JobId, string, string, string]> = [
    ['prepare', 'handoff', 'Name hand-off', 'connect-state-in'],
    ['run', 'handoff', 'Name hand-off', 'connect-state-out'],
    ['render', 'report-artifact', 'Name report artifact', 'connect-report'],
  ]
  const consumers: Array<[JobId, string, JobId, string]> = [
    ['run', 'Download hand-off', 'prepare', 'handoff'],
    ['render', 'Download hand-off', 'run', 'handoff'],
    ['post', 'Download report', 'render', 'report-artifact'],
  ]

  it('has each producing job output the name it uploaded under', () => {
    for (const [id, output, name, prefix] of producers) {
      const outputs = asRecord(job(id).outputs, `${id} outputs`)
      expect(outputs[output]).toBe('${{ steps.artifact.outputs.name }}')
      expect(stepNamed(id, name).id).toBe('artifact')
      const box = makeBox()
      const named = runStep(box, id, name, { GITHUB_RUN_ATTEMPT: '2' })
      expect(named.exitCode).toBe(0)
      expect(named.outputs.get('name')).toBe(`${prefix}-555-2`)
    }
  })

  it('has each consumer download by the producer output and never rebuild a name from the attempt', () => {
    for (const [id, name, from, output] of consumers) {
      expect(withOf(id, name).name).toBe(
        `\${{ needs.${from}.outputs.${output} }}`,
      )
    }
    for (const { step } of allSteps()) {
      if (!String(step.uses ?? '').includes('actions/download-artifact@')) {
        continue
      }
      expect(JSON.stringify(step)).not.toContain('run_attempt')
    }
  })

  it('finds the artifact an earlier attempt uploaded', () => {
    for (const [consumer, step, from, output] of consumers) {
      const producer = producers.find(
        ([id, out]) => id === from && out === output,
      )
      expect(producer).toBeDefined()
      const earlier = runStep(makeBox(), from, producer?.[2] ?? '', {
        GITHUB_RUN_ATTEMPT: '1',
      })
      const uploaded = earlier.outputs.get('name') ?? ''
      const needs = {
        [from]: { result: 'success', outputs: { [output]: uploaded } },
      }
      // The consumer runs in attempt 2; the name still points at attempt 1.
      expect(uploaded).toMatch(/-555-1$/)
      expect(resolveNeeds(String(withOf(consumer, step).name), needs)).toBe(
        uploaded,
      )
    }
  })

  it('keeps the public run record per attempt', () => {
    expect(withOf('render', 'Upload run record').name).toBe(
      'connect-run-${{ github.run_id }}-${{ github.run_attempt }}',
    )
  })
})

describe('post: runs only when render succeeded', () => {
  const rendered = (result: string, hasBody: string) => ({
    prepare: { result: 'success' },
    render: { result, outputs: { 'has-body': hasBody } },
  })

  it('posts after a successful render that made a body', () => {
    expect(jobRuns('post', rendered('success', 'true'))).toBe(true)
  })

  it('posts nothing when a render step after the body failed, as an upload does', () => {
    expect(jobRuns('post', rendered('failure', 'true'))).toBe(false)
    expect(jobRuns('post', rendered('cancelled', 'true'))).toBe(false)
  })

  it('posts nothing when render made no body, or prepare did not succeed', () => {
    expect(jobRuns('post', rendered('success', ''))).toBe(false)
    expect(
      jobRuns('post', {
        prepare: { result: 'failure' },
        render: { result: 'success', outputs: { 'has-body': 'true' } },
      }),
    ).toBe(false)
  })

  it('stays off the default branch only', () => {
    expect(
      jobRuns('post', rendered('success', 'true'), 'refs/heads/topic'),
    ).toBe(false)
  })
})

describe('render: confirming the saved cache', () => {
  it('looks the cache up on the saved key and paths with the same pinned action', () => {
    const save = withOf('render', 'Save ledger cache')
    const confirm = withOf('render', 'Confirm ledger cache')
    expect(stepIndex('render', 'Confirm ledger cache')).toBe(
      stepIndex('render', 'Save ledger cache') + 1,
    )
    const step = stepNamed('render', 'Confirm ledger cache')
    expect(step.id).toBe('cache-check')
    expect(step['continue-on-error']).toBe(true)
    expect(step.uses).toBe(stepNamed('prepare', 'Restore ledger cache').uses)
    expect(String(step.uses)).toContain('actions/cache/restore@')
    expect(confirm['lookup-only']).toBe(true)
    expect(confirm.key).toBe(save.key)
    expect(confirm.path).toBe(save.path)
    expect(confirm['restore-keys']).toBeUndefined()
    const env = asRecord(stepNamed('render', 'Finalize report').env, 'env')
    expect(env.CACHE_SAVE_OUTCOME).toBe('${{ steps.cache-save.outcome }}')
    expect(env.CACHE_HIT).toBe('${{ steps.cache-check.outputs.cache-hit }}')
  })

  it('counts a save with no cache behind it as a failed save', () => {
    for (const hit of ['', 'false']) {
      const box = makeBox()
      seedHandoff(box)
      const { render } = renderDay(box, DATE_ONE)
      const bodyFile = path.join(box.tmp, 'report', 'body.md')
      const plain = fs.readFileSync(bodyFile, 'utf8')
      const done = finalize(box, render, 'success', hit)
      const body = fs.readFileSync(bodyFile, 'utf8')
      expect(body.startsWith(plain)).toBe(true)
      expect(body).toContain('The ledger cache could not be saved for this run')
      expect(done.outputs.get('red')).toBe('true')
      expect(done.outputs.get('digest')).toBe(sha(body))
      const envelope = JSON.parse(
        fs.readFileSync(path.join(box.tmp, 'report', 'envelope.json'), 'utf8'),
      ) as Json
      expect(envelope).toMatchObject({ red: true, cacheSaved: false })
    }
  })

  it('adds the line once when the save failed and the lookup found nothing', () => {
    const box = makeBox()
    seedHandoff(box)
    const { render } = renderDay(box, DATE_ONE)
    finalize(box, render, 'failure', '')
    const body = fs.readFileSync(
      path.join(box.tmp, 'report', 'body.md'),
      'utf8',
    )
    expect(body.split('could not be saved for this run').length - 1).toBe(1)
  })
})

// ── Visibility rechecks ─────────────────────────────────────────────────────

function sourcesFrom(projectName: string, index: number): Json[] {
  return [
    {
      project: PROJECT_KEY,
      projectName,
      path: `docs/solutions/lesson-${index}.md`,
      fingerprint: sha(`fingerprint-${index}`),
      excerpt: `Excerpt of lesson ${index} from the source learning.`,
      cite: 'x',
    },
  ]
}

/** Render a first day, then a second day that proposes nothing, so every shown candidate is carried. */
function carriedDay(box: Box, projectName: string): { body: string } {
  seedHandoff(box, {
    candidates: [
      blockCandidate(1, { sources: sourcesFrom(projectName, 1) }),
      blockCandidate(2),
    ],
  })
  expect(renderDay(box, DATE_ONE).render.exitCode).toBe(0)
  handoffFromState(box, {
    marker: '556-1',
    outcome: 'failed',
    finalLine: 'Connect failed',
    runId: undefined,
    projects: undefined,
  })
  const carried = renderDay(box, DATE_TWO, { run: '556' })
  expect(carried.render.exitCode).toBe(0)
  expect(carried.body).toContain(idOf(1))
  return carried
}

const recheckRender = (
  box: Box,
  projects: string,
  env: Record<string, string> = {},
) =>
  runStep(box, 'render', 'Recheck visibility', { PROJECTS: projects, ...env })

describe('render: visibility recheck before anything is saved or uploaded', () => {
  it('sits after the report is rendered and before the cache save and every upload', () => {
    const at = (name: string) => stepIndex('render', name)
    expect(at('Recheck visibility')).toBeGreaterThan(at('Render report'))
    for (const later of [
      'Save ledger cache',
      'Confirm ledger cache',
      'Finalize report',
      'Upload report',
      'Stage run record',
      'Upload run record',
    ]) {
      expect(at('Recheck visibility')).toBeLessThan(at(later))
    }
  })

  it('reads visibility with the job token and leaves render without permissions', () => {
    const env = asRecord(stepNamed('render', 'Recheck visibility').env, 'env')
    expect(env.GH_TOKEN).toBe('${{ github.token }}')
    expect(env.PROJECTS).toBe('${{ needs.prepare.outputs.projects }}')
    expect(job('render').permissions).toEqual({})
  })

  it('passes when every repository is public and lists the repositories behind the shown candidates', () => {
    const box = makeBox()
    seedHandoff(box)
    renderDay(box, DATE_ONE)
    const result = recheckRender(box, 'acme/target')
    expect(result.exitCode).toBe(0)
    expect((result.outputs.get('repos') ?? '').split(' ').sort()).toEqual([
      'acme/target',
      'other/repo',
    ])
  })

  it('fails red with no repository list when a current project is private or unreadable', () => {
    for (const verdict of ['private', 'ERROR']) {
      const box = makeBox()
      seedHandoff(box)
      renderDay(box, DATE_ONE)
      fs.writeFileSync(
        path.join(box.fixtures, 'visibility-acme__target'),
        verdict,
      )
      const result = recheckRender(box, RUN_PROJECTS)
      expect(result.exitCode).toBe(1)
      expect(result.outputs.has('repos')).toBe(false)
      expect(ghWrites(box)).toEqual([])
    }
  })

  it('fails red when the repository a shown source came from is private, even if it left the project list', () => {
    for (const verdict of ['private', 'ERROR']) {
      const box = makeBox()
      carriedDay(box, 'gone__project')
      fs.writeFileSync(
        path.join(box.fixtures, 'visibility-gone__project'),
        verdict,
      )
      const result = recheckRender(box, 'acme/target other/repo')
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain('gone/project')
      expect(result.outputs.has('repos')).toBe(false)
    }
  })

  it('fails red when the repository a carried candidate targets is private', () => {
    const box = makeBox()
    carriedDay(box, 'other__repo')
    fs.writeFileSync(
      path.join(box.fixtures, 'visibility-acme__target'),
      'private',
    )
    const result = recheckRender(box, 'other/repo')
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('acme/target')
  })

  it('lists a carried source repository once every repository is public', () => {
    const box = makeBox()
    carriedDay(box, 'gone__project')
    const result = recheckRender(box, 'acme/target other/repo')
    expect(result.exitCode).toBe(0)
    expect((result.outputs.get('repos') ?? '').split(' ').sort()).toEqual([
      'acme/target',
      'gone/project',
      'other/repo',
    ])
  })

  it('fails closed on a shown candidate whose repository cannot be named', () => {
    const unnamed = makeBox()
    carriedDay(unnamed, 'not-a-checkout')
    expect(recheckRender(unnamed, RUN_PROJECTS).exitCode).toBe(1)

    const noTarget = makeBox()
    const dir = seedHandoff(noTarget)
    const runFile = path.join(dir, 'runs', CONNECT_RUN, 'run.json')
    const record = JSON.parse(fs.readFileSync(runFile, 'utf8')) as {
      projects: Array<Record<string, unknown>>
    }
    for (const project of record.projects) delete project.repo
    fs.writeFileSync(runFile, JSON.stringify(record))
    renderDay(noTarget, DATE_ONE)
    const result = recheckRender(noTarget, RUN_PROJECTS)
    expect(result.exitCode).toBe(1)
    expect(result.outputs.has('repos')).toBe(false)
  })

  it('refuses a malformed project entry', () => {
    const box = makeBox()
    seedHandoff(box)
    renderDay(box, DATE_ONE)
    expect(recheckRender(box, 'acme/target not-a-repo').exitCode).toBe(1)
  })

  it('checks nothing and lists nothing when the report shows no candidate', () => {
    const box = makeBox()
    seedHandoff(box, { count: 0 })
    renderDay(box, DATE_ONE)
    const result = recheckRender(box, 'acme/target')
    expect(result.exitCode).toBe(0)
    expect(result.outputs.get('repos')).toBe('acme/target')
  })
})

describe('post: visibility recheck of carried repositories', () => {
  it('stops before any write when a repository behind a shown candidate turned private or cannot be read', () => {
    for (const verdict of ['private', 'ERROR']) {
      const box = makeBox()
      fs.writeFileSync(
        path.join(box.fixtures, 'visibility-gone__project'),
        verdict,
      )
      const result = post(box, 'Recheck visibility', {
        PROJECTS: 'acme/target',
        REPOS: 'acme/target gone/project',
      })
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain('gone/project')
      expect(ghWrites(box)).toEqual([])
    }
  })

  it('checks the current projects and the carried repositories', () => {
    const box = makeBox()
    const result = post(box, 'Recheck visibility', {
      PROJECTS: 'acme/target',
      REPOS: 'gone/project',
    })
    expect(result.exitCode).toBe(0)
    const looked = calls(box).filter((line) => line.startsWith('gh api repos/'))
    expect(looked.some((line) => line.includes('repos/acme/target'))).toBe(true)
    expect(looked.some((line) => line.includes('repos/gone/project'))).toBe(
      true,
    )
  })

  it('refuses a malformed carried entry', () => {
    const box = makeBox()
    const result = post(box, 'Recheck visibility', {
      PROJECTS: 'acme/target',
      REPOS: 'not-a-repo',
    })
    expect(result.exitCode).toBe(1)
  })

  it('receives the carried list from render', () => {
    const env = asRecord(stepNamed('post', 'Recheck visibility').env, 'env')
    expect(env.REPOS).toBe('${{ needs.render.outputs.repos }}')
    expect(asRecord(job('render').outputs, 'outputs').repos).toBe(
      '${{ steps.visibility.outputs.repos }}',
    )
    expect(stepNamed('render', 'Recheck visibility').id).toBe('visibility')
  })
})

// ── Posting a rendered day ──────────────────────────────────────────────────

interface Published {
  done: StepResult
  verify: StepResult
  recheck: StepResult
  write: StepResult
  close: StepResult
  settle: StepResult
  number: number
}

/** Run the render tail and every post step, in the job's order, for a day that is already rendered. */
function publish(
  box: Box,
  render: StepResult,
  date: string,
  options: { projects?: string; between?: () => void } = {},
): Published {
  const projects = options.projects ?? RUN_PROJECTS
  const visible = runStep(box, 'render', 'Recheck visibility', {
    PROJECTS: projects,
  })
  expect(visible.exitCode).toBe(0)
  const done = finalize(box, render)
  const env = {
    DATE: date,
    PROJECTS: projects,
    REPOS: visible.outputs.get('repos') ?? '',
    RENDER_DIGEST: done.outputs.get('digest') ?? '',
    RENDER_CHARS: done.outputs.get('chars') ?? '',
    RENDER_RED: done.outputs.get('red') ?? '',
  }
  const verify = post(box, 'Verify report', env)
  const recheck = post(box, 'Recheck visibility', env)
  const write = post(box, 'Write report', env)
  options.between?.()
  const close = post(box, 'Close superseded reports', {
    ...env,
    NUMBER: write.outputs.get('number') ?? '',
  })
  const settle = post(box, 'Settle result', env)
  return {
    done,
    verify,
    recheck,
    write,
    close,
    settle,
    number: Number(write.outputs.get('number') ?? '0'),
  }
}

function liveBody(box: Box, number: number): string {
  return issuesOf(box).find((issue) => issue.number === number)?.body ?? ''
}

function setIssueBody(box: Box, number: number, body: string): void {
  const issues = issuesOf(box).map((issue) =>
    issue.number === number ? { ...issue, body } : issue,
  )
  fs.writeFileSync(
    path.join(box.fixtures, 'issues.json'),
    JSON.stringify(issues),
  )
}

/** A first day: render it and post it as a new report. */
function firstDay(box: Box, date = DATE_ONE): { number: number; body: string } {
  seedHandoff(box)
  const day = renderDay(box, date)
  expect(day.render.exitCode).toBe(0)
  const out = publish(box, day.render, date)
  expect(out.settle.exitCode).toBe(0)
  expect(out.number).toBeGreaterThan(0)
  return { number: out.number, body: day.body }
}

/** A later run: the state the cache holds, rendered again for a date. */
function nextDay(box: Box, date: string): { render: StepResult; body: string } {
  handoffFromState(box, { marker: '556-1' })
  const day = renderDay(box, date, { run: '556' })
  expect(day.render.exitCode).toBe(0)
  return day
}

const unticked = (body: string): string => body.replaceAll('- [x]', '- [ ]')

/** The stub gh reads a body file through `$(cat ...)`, which drops trailing newlines. */
const trimmed = (text: string): string => text.replace(/\n+$/, '')

const FOUND = { REPO: 'marcusrbrown/systematic' }

describe('post: ticks made while a run was executing', () => {
  it('keeps a tick made after prepare when the same-date report is edited', () => {
    const box = makeBox()
    const { number, body } = firstDay(box)
    setIssueBody(box, number, tick(body, 1, 'rejected'))

    const second = nextDay(box, DATE_ONE)
    expect(second.body).toContain(decisionLine(idOf(1), 'rejected', false))
    const out = publish(box, second.render, DATE_ONE)
    expect(out.settle.exitCode).toBe(0)
    expect(out.number).toBe(number)

    const posted = liveBody(box, number)
    expect(posted).toContain(decisionLine(idOf(1), 'rejected', true))
    expect(posted).toContain(decisionLine(idOf(1), 'promoted', false))
    expect(posted).toContain(decisionLine(idOf(2), 'rejected', false))
    // Only checkbox characters differ from the body that was verified.
    expect(unticked(posted)).toBe(trimmed(second.body))
    expect(issuesOf(box)).toHaveLength(1)
  })

  it('has the next run record that tick against the new body, whose manifest holds the id', () => {
    const box = makeBox()
    const { number, body } = firstDay(box)
    setIssueBody(box, number, tick(body, 1, 'rejected'))
    const second = nextDay(box, DATE_ONE)
    publish(box, second.render, DATE_ONE)

    const posted = liveBody(box, number)
    const found = runStep(box, 'prepare', 'Find the open report', FOUND)
    expect(found.outputs.get('report')).toBe(String(number))
    const applied = recordTicks(box, number)
    expect(applied.stdout).toContain('accepted 1')
    expect(statusOf(box, 1)).toBe('rejected')
    const marker = /<!-- connect-manifest:([0-9a-f]{16}) -->/.exec(posted)?.[1]
    const store = JSON.parse(
      fs.readFileSync(path.join(stateRootOf(box), 'ci-manifests.json'), 'utf8'),
    ) as { manifests: Array<{ hash: string; ids: string[] }> }
    expect(
      store.manifests.find((manifest) => manifest.hash === marker)?.ids,
    ).toContain(idOf(1))
  })

  it('keeps a tick made after prepare when a new date rotates the report', () => {
    const box = makeBox()
    const { number, body } = firstDay(box)
    setIssueBody(box, number, tick(body, 2, 'promoted'))

    const second = nextDay(box, DATE_TWO)
    const out = publish(box, second.render, DATE_TWO)
    expect(out.settle.exitCode).toBe(0)
    expect(out.number).not.toBe(number)

    const posted = liveBody(box, out.number)
    expect(posted).toContain(decisionLine(idOf(2), 'promoted', true))
    expect(unticked(posted)).toBe(trimmed(second.body))
    expect(issuesOf(box).find((i) => i.number === number)?.state).toBe('closed')

    runStep(box, 'prepare', 'Find the open report', FOUND)
    expect(recordTicks(box, out.number).stdout).toContain('accepted 1')
    expect(statusOf(box, 2)).toBe('promoted')
  })

  it('keeps a tick made between the write and the close', () => {
    const box = makeBox()
    const { number, body } = firstDay(box)
    const second = nextDay(box, DATE_TWO)
    const out = publish(box, second.render, DATE_TWO, {
      between: () => setIssueBody(box, number, tick(body, 1, 'rejected')),
    })
    expect(out.close.exitCode).toBe(0)
    const posted = liveBody(box, out.number)
    expect(posted).toContain(decisionLine(idOf(1), 'rejected', true))
    expect(unticked(posted)).toBe(trimmed(second.body))
    expect(issuesOf(box).find((i) => i.number === number)?.state).toBe('closed')
  })

  it('carries an upper-case X the way the tick reader counts it', () => {
    const box = makeBox()
    const { number, body } = firstDay(box)
    setIssueBody(
      box,
      number,
      tick(body, 1, 'rejected').replace('- [x] Rejected', '- [X] Rejected'),
    )
    const second = nextDay(box, DATE_ONE)
    publish(box, second.render, DATE_ONE)
    expect(liveBody(box, number)).toContain(
      decisionLine(idOf(1), 'rejected', true),
    )
  })

  const forged = decisionLine(idOf(1), 'rejected', true)
  const begin = '<!-- connect-decisions:begin -->'
  const notCarried: Array<[string, (body: string) => string]> = [
    [
      'a backtick fence in the section',
      (body) => body.replace(begin, `${begin}\n\`\`\`\n${forged}\n\`\`\``),
    ],
    [
      'a tilde fence in the section',
      (body) => body.replace(begin, `${begin}\n~~~\n${forged}\n~~~`),
    ],
    ['a line before the section', (body) => `${forged}\n${body}`],
    ['a line after the section', (body) => `${body}\n${forged}\n`],
    [
      'an id the new body does not list',
      (body) =>
        body.replace(
          begin,
          `${begin}\n${decisionLine(idOf(9), 'rejected', true)}`,
        ),
    ],
  ]
  for (const [label, forge] of notCarried) {
    it(`carries no tick from ${label}`, () => {
      const box = makeBox()
      const { number, body } = firstDay(box)
      setIssueBody(box, number, forge(body))
      const second = nextDay(box, DATE_ONE)
      const out = publish(box, second.render, DATE_ONE)
      expect(out.settle.exitCode).toBe(0)
      expect(liveBody(box, number)).toBe(trimmed(second.body))
    })
  }

  it('drops the tick for a candidate the new body no longer lists and keeps the others', () => {
    const box = makeBox()
    const { number, body } = firstDay(box)
    const settled = tick(body, 1, 'rejected')
    setIssueBody(box, number, settled)
    runStep(box, 'prepare', 'Find the open report', FOUND)
    expect(recordTicks(box, number).stdout).toContain('accepted 1')
    setIssueBody(box, number, tick(settled, 2, 'promoted'))

    const second = nextDay(box, DATE_ONE)
    expect(second.body).not.toContain(idOf(1))
    publish(box, second.render, DATE_ONE)
    const posted = liveBody(box, number)
    expect(posted).not.toContain(idOf(1))
    expect(posted).toContain(decisionLine(idOf(2), 'promoted', true))
    expect(unticked(posted)).toBe(trimmed(second.body))
  })

  it('writes nothing when a live body cannot be read', () => {
    const box = makeBox()
    const { number, body } = firstDay(box)
    setIssueBody(box, number, tick(body, 1, 'rejected'))
    const second = nextDay(box, DATE_ONE)
    const done = finalize(box, second.render)
    const writes = ghWrites(box).length
    const result = post(box, 'Write report', {
      DATE: DATE_ONE,
      RENDER_DIGEST: done.outputs.get('digest') ?? '',
      RENDER_CHARS: done.outputs.get('chars') ?? '',
      GH_FAIL_AT: `issues/${number}`,
    })
    expect(result.exitCode).toBe(1)
    expect(result.outputs.has('number')).toBe(false)
    expect(ghWrites(box)).toHaveLength(writes)
    expect(liveBody(box, number)).toBe(tick(body, 1, 'rejected'))
  })
})

describe('post: a report is edited in place across the day', () => {
  it('records a tick, then edits the same issue with the settled candidate gone and opens no second issue', () => {
    const box = makeBox()
    const { number, body } = firstDay(box)
    expect(issuesOf(box)).toHaveLength(1)
    setIssueBody(box, number, tick(body, 1, 'rejected'))

    // The next run on the same date: look the report up, record its ticks, render, post.
    const found = runStep(box, 'prepare', 'Find the open report', FOUND)
    expect(found.outputs.get('report')).toBe(String(number))
    const applied = recordTicks(box, number)
    expect(applied.stdout).toContain('accepted 1')
    expect(statusOf(box, 1)).toBe('rejected')
    expect(statusOf(box, 2)).toBe('candidate')

    const second = nextDay(box, DATE_ONE)
    const out = publish(box, second.render, DATE_ONE)
    expect(out.settle.exitCode).toBe(0)
    expect(out.number).toBe(number)

    const issues = issuesOf(box)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.state).toBe('open')
    const posted = liveBody(box, number)
    expect(posted).not.toContain(idOf(1))
    expect(posted).toContain(decisionLine(idOf(2), 'rejected', false))
    expect(posted).toBe(trimmed(second.body))
    const creates = calls(box).filter((entry) =>
      /-X POST repos\/[^ ]+\/issues /.test(entry),
    )
    expect(creates).toHaveLength(1)
  })
})

describe('post: failed and unfinished runs are posted, then the workflow turns red', () => {
  const cases: Array<[string, Json, RegExp]> = [
    [
      'failed',
      {
        outcome: 'failed',
        finalLine: 'Connect failed',
        reason: 'unsupported-host',
      },
      /Connect failed/,
    ],
    [
      'begun with no terminal record',
      { phase: 'begun', outcome: undefined, finalLine: undefined },
      /ended with no final line/,
    ],
  ]
  for (const [label, invocation, sentence] of cases) {
    it(`posts the ${label} run and then settles red`, () => {
      const box = makeBox()
      seedHandoff(box, { invocation })
      const day = renderDay(box, DATE_ONE)
      expect(day.render.exitCode).toBe(0)
      const out = publish(box, day.render, DATE_ONE)
      // Render succeeded, so the post job runs; its redness comes from the outputs.
      expect(
        jobRuns('post', {
          prepare: { result: 'success' },
          render: {
            result: 'success',
            outputs: { 'has-body': out.done.outputs.get('has-body') ?? '' },
          },
        }),
      ).toBe(true)
      expect(out.verify.exitCode).toBe(0)
      expect(out.recheck.exitCode).toBe(0)
      expect(out.write.exitCode).toBe(0)
      expect(out.close.exitCode).toBe(0)
      expect(liveBody(box, out.number)).toBe(trimmed(day.body))
      expect(liveBody(box, out.number)).toMatch(sentence)
      expect(out.settle.exitCode).toBe(1)
      expect(out.settle.stdout + out.settle.stderr).toContain('ce:connect')
    })
  }
})

// ── Checkout names, and the state that leaves a job ────────────────────────

describe('prepare: checkout names the helper keeps whole', () => {
  const entryOf100 = `${'a'.repeat(39)}/${'b'.repeat(59)}`
  const entryOf101 = `${'a'.repeat(39)}/${'b'.repeat(60)}`
  const checkoutOf = (entry: string): string => entry.replace('/', '__')

  it('accepts an entry whose owner__repo name is exactly 100 characters', () => {
    expect(checkoutOf(entryOf100)).toHaveLength(100)
    const box = makeBox()
    const result = runStep(box, 'prepare', 'Validate configuration', {
      ...CONFIG_ENV,
      PROJECTS_RAW: `acme/target ${entryOf100}`,
    })
    expect(result.exitCode).toBe(0)
    expect(result.outputs.get('projects')).toBe(`acme/target ${entryOf100}`)
  })

  it('refuses an entry whose owner__repo name is 101 characters, naming it, before any lookup', () => {
    expect(checkoutOf(entryOf101)).toHaveLength(101)
    const box = makeBox()
    const result = runStep(box, 'prepare', 'Validate configuration', {
      ...CONFIG_ENV,
      PROJECTS_RAW: `acme/target ${entryOf101}`,
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain(entryOf101)
    expect(result.stdout).toContain('over 100 characters')
    expect(result.outputs.has('projects')).toBe(false)
    expect(
      calls(box).filter((line) => line.startsWith('gh api repos/')),
    ).toEqual([])
  })

  it('keeps the helper project name equal to the checkout name up to the limit and not beyond it', () => {
    const at = (entry: string): string =>
      projectName(`/runner/work/connect/checkouts/${checkoutOf(entry)}`)
    expect(at(entryOf100)).toBe(checkoutOf(entryOf100))
    expect(at(entryOf101)).not.toBe(checkoutOf(entryOf101))
    // Every character a validated entry can hold survives the helper's reduction.
    for (const entry of ['a-b/c.d_e-f', 'x/_y', 'x/y__z', '9/0.-_']) {
      expect(at(entry)).toBe(checkoutOf(entry))
    }
  })
})

// ── Retained state is checked before it leaves a job ───────────────────────

interface Walked {
  failedAt: string | undefined
  /** Steps that would upload an artifact or save a cache and were reached. */
  effects: string[]
  results: Map<string, StepResult>
}

/**
 * Run a job's shell steps in order, as the runner does: stop at the first step
 * that fails, and note each upload or cache save it reaches. Steps with an `if`
 * and other actions are skipped.
 */
function walkJob(box: Box, id: JobId, env: Record<string, string>): Walked {
  const effects: string[] = []
  const results = new Map<string, StepResult>()
  for (const step of stepsOf(id)) {
    const name = asString(step.name, 'step name')
    if (step.if !== undefined) continue
    const uses = String(step.uses ?? '')
    if (uses.includes('upload-artifact@') || uses.includes('cache/save@')) {
      effects.push(name)
      continue
    }
    if (step.run === undefined) continue
    const result = runStep(box, id, name, env)
    results.set(name, result)
    if (result.exitCode !== 0 && step['continue-on-error'] !== true) {
      return { failedAt: name, effects, results }
    }
  }
  return { failedAt: undefined, effects, results }
}

const PREPARE_ENV = {
  ...CONFIG_ENV,
  FAKE_DATE: DATE_ONE,
  REPO: 'marcusrbrown/systematic',
  CACHE_MATCHED_KEY: 'connect-v1-1-1',
  PROJECTS: 'acme/target other/repo',
}

const RENDER_ENV = {
  DATE: DATE_ONE,
  CACHE_RESTORED: 'true',
  PROJECTS: 'acme/target other/repo',
  RENDER_RED: 'false',
  RENDER_MANIFEST: '',
  RENDER_OUTCOME: 'complete',
  CACHE_SAVE_OUTCOME: 'success',
  CACHE_HIT: 'true',
}

const PRIVATE_NOW = (box: Box, slug: string, verdict = 'private'): void =>
  fs.writeFileSync(path.join(box.fixtures, `visibility-${slug}`), verdict)

/** A render of many large candidates, so the report cap hides the last one. */
function crowdedDay(box: Box, hiddenProject: string): { body: string } {
  const candidates = Array.from({ length: 30 }, (_, i) => {
    const n = i + 1
    const project = n === 30 ? hiddenProject : SOURCE_PROJECT
    return blockCandidate(n, {
      summary: 'S'.repeat(790),
      sources: Array.from({ length: 8 }, (_, s) => ({
        ...sourcesFrom(project, n)[0],
        path: `docs/solutions/lesson-${n}-${s}.md`,
        excerpt: 'E'.repeat(230),
      })),
    })
  })
  seedHandoff(box, { count: 30, candidates })
  const day = renderDay(box, DATE_ONE)
  expect(day.render.exitCode).toBe(0)
  expect(day.body).not.toContain(idOf(30))
  expect(day.body).toContain('not shown')
  return day
}

/** A retained run record, as an earlier run left it in the cache. */
function retainRunRecord(box: Box, repo: string): void {
  writeJson(
    path.join(
      stateRootOf(box),
      'runs',
      '20260101T000000Z-aaaaaaaa',
      'run.json',
    ),
    { schemaVersion: 1, projects: [{ name: 'old', repo }] },
  )
}

const RECOVERY = [
  'no longer public',
  'gh cache list --key connect-v1-',
  'gh cache delete',
]

const recheckPrepare = (box: Box, projects = 'acme/target other/repo') =>
  runStep(box, 'prepare', 'Recheck cached state', {
    PROJECTS: projects,
  })

describe('prepare: cached state is checked before the hand-off is uploaded', () => {
  it('runs after the cache is restored and before the first upload', () => {
    const at = (name: string) => stepIndex('prepare', name)
    expect(at('Recheck cached state')).toBeGreaterThan(
      at('Restore ledger cache'),
    )
    expect(at('Recheck cached state')).toBeLessThan(at('Upload hand-off'))
    const env = asRecord(
      stepNamed('prepare', 'Recheck cached state').env,
      'env',
    )
    expect(env.GH_TOKEN).toBe('${{ github.token }}')
    expect(env.PROJECTS).toBe('${{ steps.config.outputs.projects }}')
  })

  it('is the same script render runs, so the two cannot drift', () => {
    expect(stepNamed('prepare', 'Recheck cached state').run).toBe(
      stepNamed('render', 'Recheck visibility').run,
    )
  })

  const holders: Array<[string, (box: Box) => void]> = [
    [
      'a payload source',
      (box) => {
        seedHandoff(box, {
          candidates: [
            blockCandidate(1, { sources: sourcesFrom('gone__project', 1) }),
            blockCandidate(2),
          ],
        })
        renderDay(box, DATE_ONE)
      },
    ],
    [
      'a candidate the report cap hides',
      (box) => void crowdedDay(box, 'gone__project'),
    ],
    [
      'a retained run record',
      (box) => {
        runStep(box, 'prepare', 'Create state root')
        retainRunRecord(box, 'gone/project')
      },
    ],
  ]
  for (const [label, arrange] of holders) {
    for (const verdict of ['private', 'ERROR']) {
      it(`fails red with nothing uploaded when a removed repository named only by ${label} is ${verdict === 'ERROR' ? 'unreadable' : 'private'}`, () => {
        const box = makeBox()
        arrange(box)
        PRIVATE_NOW(box, 'gone__project', verdict)
        const ledger = fs.existsSync(path.join(stateRootOf(box), 'ledger.json'))
          ? ledgerBytes(box)
          : ''
        const walked = walkJob(box, 'prepare', PREPARE_ENV)
        expect(walked.failedAt).toBe('Recheck cached state')
        expect(walked.effects).toEqual([])
        const out = walked.results.get('Recheck cached state')
        expect(out?.stdout).toContain('gone/project')
        for (const phrase of RECOVERY) expect(out?.stdout).toContain(phrase)
        expect(ghWrites(box)).toEqual([])
        if (ledger !== '') expect(ledgerBytes(box)).toBe(ledger)
      })
    }
  }

  it('uploads once every repository the state names is public, and lists them', () => {
    const box = makeBox()
    holders[0]?.[1](box)
    const walked = walkJob(box, 'prepare', PREPARE_ENV)
    expect(walked.failedAt).toBeUndefined()
    expect(walked.effects).toEqual(['Upload hand-off'])
    const listed = walked.results
      .get('Recheck cached state')
      ?.outputs.get('repos')
    expect((listed ?? '').split(' ').sort()).toEqual([
      'acme/target',
      'gone/project',
      'other/repo',
    ])
  })

  it('checks nothing and passes when there is no cached state', () => {
    const box = makeBox()
    runStep(box, 'prepare', 'Create state root')
    const result = recheckPrepare(box)
    expect(result.exitCode).toBe(0)
    expect(result.outputs.get('repos')).toBe('acme/target other/repo')
  })
})

describe('render: all retained state is checked before the cache or any artifact leaves', () => {
  const holders: Array<[string, (box: Box) => void]> = [
    [
      'a payload source',
      (box) => {
        seedHandoff(box, {
          candidates: [
            blockCandidate(1, { sources: sourcesFrom('gone__project', 1) }),
            blockCandidate(2),
          ],
        })
      },
    ],
    [
      'a candidate the report cap hides',
      (box) => {
        const candidates = Array.from({ length: 30 }, (_, i) => {
          const n = i + 1
          const project = n === 30 ? 'gone__project' : SOURCE_PROJECT
          return blockCandidate(n, {
            summary: 'S'.repeat(790),
            sources: Array.from({ length: 8 }, (_, s) => ({
              ...sourcesFrom(project, n)[0],
              path: `docs/solutions/lesson-${n}-${s}.md`,
              excerpt: 'E'.repeat(230),
            })),
          })
        })
        seedHandoff(box, { count: 30, candidates })
      },
    ],
    [
      'a retained run record',
      (box) => {
        const dir = seedHandoff(box)
        writeJson(
          path.join(dir, 'runs', '20260101T000000Z-aaaaaaaa', 'run.json'),
          {
            schemaVersion: 1,
            projects: [{ name: 'old', repo: 'gone/project' }],
          },
        )
      },
    ],
  ]
  for (const [label, arrange] of holders) {
    for (const verdict of ['private', 'ERROR']) {
      it(`fails red with nothing cached or uploaded when a removed repository named only by ${label} is ${verdict === 'ERROR' ? 'unreadable' : 'private'}`, () => {
        const box = makeBox()
        arrange(box)
        PRIVATE_NOW(box, 'gone__project', verdict)
        const walked = walkJob(box, 'render', RENDER_ENV)
        expect(walked.failedAt).toBe('Recheck visibility')
        expect(walked.effects).toEqual([])
        const out = walked.results.get('Recheck visibility')
        expect(out?.stdout).toContain('gone/project')
        for (const phrase of RECOVERY) expect(out?.stdout).toContain(phrase)
        expect(out?.outputs.has('repos')).toBe(false)
        expect(ghWrites(box)).toEqual([])
      })
    }
  }

  it('saves the cache and uploads once every repository the state names is public', () => {
    const box = makeBox()
    holders[2]?.[1](box)
    const walked = walkJob(box, 'render', RENDER_ENV)
    expect(walked.failedAt).toBeUndefined()
    expect(walked.effects).toEqual(['Save ledger cache', 'Upload report'])
    const listed = walked.results
      .get('Recheck visibility')
      ?.outputs.get('repos')
    expect((listed ?? '').split(' ').sort()).toEqual([
      'acme/target',
      'gone/project',
      'other/repo',
    ])
  })

  it('tells the operator the cache holds the repository only when it is not on the current list', () => {
    const box = makeBox()
    seedHandoff(box)
    renderDay(box, DATE_ONE)
    PRIVATE_NOW(box, 'acme__target')
    const out = recheckRender(box, 'acme/target other/repo')
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('acme/target is not confirmed public')
    expect(out.stdout).not.toContain('gh cache delete')
  })
})
