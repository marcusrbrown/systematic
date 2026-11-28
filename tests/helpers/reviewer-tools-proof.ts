/**
 * Runs one dispatched agent on a real OpenCode host and records the tool names
 * the host offered to the parent and to the child, shared by the OpenCode v1
 * and v2 integration files.
 *
 * A scripted model drives a parent that dispatches the named agent once. The
 * child makes one call, by default a read of a file outside the project, and
 * then answers at once. The run returns the tool list of the parent's first
 * request and of the child's first request, the child's call result, and the
 * host's stderr, so a test can say what a dispatched agent is offered and how
 * a read behaves for it compared with an agent that has no permission block.
 *
 * What this does not prove: a live model choosing to call a tool. The offered
 * list is what the host puts in the model request.
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  buildIsolatedOpencodeEnv,
  buildOpencodeRunArgv,
  extractPackagedPlugin,
  type IsolatedFixture,
  type OpencodeHost,
  REPO_ROOT,
  type ScriptedModelServer,
  scriptedResponseChunks,
  spawnOpencodeChild,
  TIMEOUT_MS,
  withScriptedProvider,
  writeHostProjectConfig,
} from '../integration/fixtures/opencode-host.js'
import { agentSystemMarker } from './connect-delegated-proof.js'
import {
  type ChatRequest,
  hasResearcherSystemMarker,
  isSubagentLaunch,
  lastUserTextOf,
  messageText,
  parentResultTextOf,
  roleOf,
  toolNamesOf,
} from './delegated-search-proof.js'

export type ReviewerHost = Extract<OpencodeHost, 'v1' | 'v2'>

/** The shipped review agent the proof dispatches. */
export const REVIEWER_AGENT = 'correctness-reviewer'

/** A shipped agent with no `permission:` block, dispatched as the control. */
export const CONTROL_AGENT = 'learnings-researcher'

/** What the scripted child's answer holds. */
export const REVIEWER_CHILD_FINAL = 'CHILD-DONE'

/** What the scripted parent's answer holds. */
export const REVIEWER_PARENT_FINAL = 'PARENT-FINAL'

/** The text the planted outside file carries. */
export const EXTERNAL_NOTE_MARKER = 'EXTERNAL-NOTE-MARKER-4c1d'

/** The text the planted `.env` file in the project carries. */
export const ENV_FILE_MARKER = 'PROJECT-ENV-MARKER-8a35'

/** The id and body text of the project skill a run can plant. */
export const PLANTED_SKILL_ID = 'reviewer-probe-skill'
export const PLANTED_SKILL_MARKER = 'REVIEWER-PROBE-SKILL-BODY-7e21'

const PARENT_DIRECTIVE = '@@REVIEWER-PARENT-DISPATCH'
const CHILD_PROMPT_MARK = 'REVIEWER-OFFER-CHILD'

/** Model requests one run may make; a passing run makes about five. */
const REQUEST_CAP = 12

/** The tool names a host registers for each role the proof checks. */
export interface ReviewerHostTools {
  readonly read: string
  readonly grep: string
  readonly glob: string
  readonly shell: string
  readonly dispatch: string
  /** The path argument of the read tool. */
  readonly readPathKey: string
}

export const REVIEWER_HOST_TOOLS = {
  v1: {
    read: 'read',
    grep: 'grep',
    glob: 'glob',
    shell: 'bash',
    dispatch: 'task',
    readPathKey: 'filePath',
  },
  v2: {
    read: 'read',
    grep: 'grep',
    glob: 'glob',
    shell: 'shell',
    dispatch: 'subagent',
    readPathKey: 'path',
  },
} as const satisfies Record<ReviewerHost, ReviewerHostTools>

/**
 * Tools the review agents' deny list names, in each host's tool names. The
 * parent must be offered each name in `checkedOnParent`, so a typo cannot
 * pass; `childOnly` names are checked on the child alone because the parent's
 * host or version may not offer them. Everything else a host offers stays on
 * the child: the proof compares against a control child, not a fixed list.
 */
export interface ReviewerWithheldTools {
  readonly checkedOnParent: readonly string[]
  readonly childOnly: readonly string[]
}

export const REVIEWER_WITHHELD_TOOLS = {
  v1: {
    checkedOnParent: [
      'task',
      'todowrite',
      'skill',
      'systematic_skill',
      'write',
      'edit',
    ],
    childOnly: [
      'patch',
      'apply_patch',
      'websearch',
      'question',
      'generate_image',
      'generate_video',
      'session_list',
      'session_info',
      'session_search',
      'session_read',
    ],
  },
  v2: {
    checkedOnParent: [
      'subagent',
      'systematic_skill',
      'write',
      'edit',
      'websearch',
      'question',
    ],
    childOnly: [
      'patch',
      'apply_patch',
      'todowrite',
      'generate_image',
      'generate_video',
      'session_list',
      'session_info',
      'session_search',
      'session_read',
    ],
  },
} as const satisfies Record<ReviewerHost, ReviewerWithheldTools>

/**
 * Tools a host may offer a review agent that the proof neither requires nor
 * forbids. A v2 host may offer `skill` to a review agent and refuse the call,
 * or hide it; a call to it fails either way (see `skillCallFailures`).
 */
export const TOLERATED_REVIEWER_TOOLS = {
  v1: [],
  v2: ['skill'],
} as const satisfies Record<ReviewerHost, readonly string[]>

/** The offered names that are not tolerated for a review agent on `host`. */
export function withoutTolerated(
  host: ReviewerHost,
  names: readonly string[],
): string[] {
  const tolerated: readonly string[] = TOLERATED_REVIEWER_TOOLS[host]
  return names.filter((name) => !tolerated.includes(name))
}

/** Tools a host takes from every dispatched child, whatever the agent's permissions say. */
export const HOST_SUBAGENT_WITHHELD = {
  v1: ['task', 'todowrite'],
  v2: [],
} as const satisfies Record<ReviewerHost, readonly string[]>

// ── A throwaway agent defined directly on the host ───────────────────────────

export const THROWAWAY_AGENT = 'throwaway-probe'
export const THROWAWAY_MARKER = 'THROWAWAY-AGENT-MARKER-9b2e'

export type PermissionSetting = 'allow' | 'deny' | 'ask'

export interface ThrowawayPermission {
  /** Entries in order, written in the v1 vocabulary (`bash`); `*` is the wildcard. */
  readonly entries: readonly (readonly [string, PermissionSetting])[]
  /**
   * How a v1 host receives each entry: `bare` is `name: setting`, `rule-map`
   * is `name: { '*': setting }`, the shape the managed v1 fold emits.
   * A v2 host always receives ordered rules.
   */
  readonly v1Form?: 'bare' | 'rule-map'
}

/**
 * Host config that defines `THROWAWAY_AGENT` as a subagent with the given
 * permission list, written straight into the host config so Systematic's
 * parser is not involved. Without entries the agent has no permission block.
 */
export function throwawayAgentConfig(
  host: ReviewerHost,
  permission: ThrowawayPermission | undefined,
): Record<string, unknown> {
  const prompt = `${THROWAWAY_MARKER} You are a throwaway probe agent.`
  const entries = permission?.entries ?? []
  if (host === 'v2') {
    return {
      agents: {
        [THROWAWAY_AGENT]: {
          mode: 'subagent',
          description: 'Throwaway probe agent',
          system: prompt,
          ...(entries.length > 0 && {
            permissions: entries.map(([name, effect]) => ({
              action: name === 'bash' ? 'shell' : name,
              resource: '*',
              effect,
            })),
          }),
        },
      },
    }
  }
  const ruleMap = permission?.v1Form === 'rule-map'
  return {
    agent: {
      [THROWAWAY_AGENT]: {
        mode: 'subagent',
        description: 'Throwaway probe agent',
        prompt,
        ...(entries.length > 0 && {
          permission: Object.fromEntries(
            entries.map(([name, setting]) => [
              name,
              ruleMap ? { '*': setting } : setting,
            ]),
          ),
        }),
      },
    },
  }
}

/**
 * Host config carrying the user's own host-wide rule that denies the shell, in
 * the host's own config shape: a top-level `permission` map on v1, a
 * top-level `permissions` rule list on v2. It is not a Systematic overlay.
 */
export function hostShellDenyConfig(
  host: ReviewerHost,
): Record<string, unknown> {
  if (host === 'v2') {
    return {
      permissions: [{ action: 'shell', resource: '*', effect: 'deny' }],
    }
  }
  return { permission: { bash: 'deny' } }
}

// ── The scripted model ───────────────────────────────────────────────────────

export interface ReviewerOfferScriptOptions {
  dispatch: { tool: string; arguments: Record<string, unknown> }
  /** The one call the child makes before it answers. */
  childCall: { tool: string; arguments: Record<string, unknown> }
  isChildRequest: (request: ChatRequest) => boolean
}

export interface ReviewerOfferObservation {
  requestCount: number
  parentRequests: readonly ChatRequest[]
  childRequests: readonly ChatRequest[]
}

export interface ReviewerOfferScript {
  respond(request: ChatRequest): { text: string } | { toolCalls: ToolCall[] }
  observation(): ReviewerOfferObservation
}

interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

function toolResultsOf(request: ChatRequest): string[] {
  return (request.messages ?? [])
    .filter((message) => roleOf(message) === 'tool')
    .map((message) => messageText(message))
}

/**
 * A request that offers no tools is the session title. The parent dispatches
 * once and answers when the child's result comes back; the child makes its one
 * call and answers on the next turn.
 */
export function createReviewerOfferScript(
  options: ReviewerOfferScriptOptions,
): ReviewerOfferScript {
  const parentRequests: ChatRequest[] = []
  const childRequests: ChatRequest[] = []
  let requestCount = 0
  let dispatched = false

  function childTurn(request: ChatRequest) {
    if (toolResultsOf(request).length > 0) {
      return { text: REVIEWER_CHILD_FINAL }
    }
    return {
      toolCalls: [
        {
          id: 'reviewer-offer-child-call',
          name: options.childCall.tool,
          arguments: { ...options.childCall.arguments },
        },
      ],
    }
  }

  function parentTurn(request: ChatRequest) {
    if (isSubagentLaunch(request)) return { text: 'PARENT-WAITING' }
    if (parentResultTextOf(request) !== undefined) {
      return { text: REVIEWER_PARENT_FINAL }
    }
    if (dispatched) return { text: 'PARENT-UNEXPECTED-TURN' }
    dispatched = true
    return {
      toolCalls: [
        {
          id: 'reviewer-offer-dispatch',
          name: options.dispatch.tool,
          arguments: { ...options.dispatch.arguments },
        },
      ],
    }
  }

  return {
    respond(request) {
      requestCount += 1
      if (requestCount > REQUEST_CAP) return { text: 'REQUEST-CAP-EXCEEDED' }
      if (toolNamesOf(request).length === 0) return { text: 'Scripted title' }
      if (options.isChildRequest(request)) {
        childRequests.push(request)
        return childTurn(request)
      }
      parentRequests.push(request)
      return parentTurn(request)
    },
    observation: () => ({
      requestCount,
      parentRequests: [...parentRequests],
      childRequests: [...childRequests],
    }),
  }
}

function startScriptedModel(
  script: Pick<ReviewerOfferScript, 'respond'>,
): ScriptedModelServer {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        !request.url.endsWith('/chat/completions')
      ) {
        return new Response('not found', { status: 404 })
      }
      const body = (await request.json()) as ChatRequest
      const chunks = scriptedResponseChunks(
        script.respond(body),
        'reviewer-offer-response',
        Math.floor(Date.now() / 1000),
      )
      const sse = [
        ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
        'data: [DONE]\n\n',
      ].join('')
      return new Response(new TextEncoder().encode(sse), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

/** The first line of a shipped agent's body, which every host puts in the child's system prompt. */
export function shippedAgentMarker(agent: string): string {
  const dir = path.join(REPO_ROOT, 'agents')
  for (const category of fs.readdirSync(dir)) {
    const file = path.join(dir, category, `${agent}.md`)
    if (fs.existsSync(file)) {
      return agentSystemMarker(fs.readFileSync(file, 'utf8'))
    }
  }
  throw new Error(`no shipped agent file named ${agent}.md under ${dir}`)
}

export interface ReviewerOfferOptions {
  /** The agent the parent dispatches. */
  agent: string
  /** Text from the agent's system prompt, so the run knows the right agent ran. */
  marker: string
  /**
   * Extra host config merged into the run's config, for example a throwaway
   * agent defined directly on the host. The plugin list and the scripted
   * provider are added by the run.
   */
  hostConfig?: Record<string, unknown>
  /**
   * Written as the user-level Systematic config, where agent permission
   * overlays are valid.
   */
  systematicConfig?: Record<string, unknown>
  /**
   * The file the child's default call reads: a planted note outside the
   * project (the default) or a planted `.env` file in the project root.
   */
  childRead?: 'external-note' | 'project-env'
  /** The one call the child makes. Overrides `childRead`. */
  childCall?: { tool: string; arguments: Record<string, unknown> }
  /** Plants a project skill named `PLANTED_SKILL_ID` whose body holds `PLANTED_SKILL_MARKER`. */
  plantSkill?: boolean
}

export interface ReviewerOfferRun {
  exitCode: number
  stdout: string
  stderr: string
  requestCount: number
  parentOffered: string[]
  childOffered: string[]
  /** How many model requests came from the child. */
  childRequestCount: number
  /** True when every child request carried the agent's system marker. */
  childIsAgent: boolean
  /** The result of the child's one call; by default a read of a file outside the project. */
  childCallResult: string | undefined
}

/**
 * Runs the parent through `opencode run` on `host` with the packed plugin
 * loaded, dispatching `options.agent` once. The child makes one call, by
 * default a read of a planted file outside the project directory, and then
 * answers.
 */
export async function runReviewerOffer(
  host: ReviewerHost,
  fixture: IsolatedFixture,
  options: ReviewerOfferOptions,
): Promise<ReviewerOfferRun> {
  const tools = REVIEWER_HOST_TOOLS[host]
  const { pluginSpec } = extractPackagedPlugin(fixture, host)
  const externalDir = path.join(
    fs.realpathSync(fixture.tempRoot),
    'external-notes',
  )
  const externalNote = path.join(externalDir, 'note.txt')
  fs.mkdirSync(externalDir, { recursive: true })
  fs.writeFileSync(externalNote, `${EXTERNAL_NOTE_MARKER}\n`)
  const envFile = path.join(fs.realpathSync(fixture.projectDir), '.env')
  if (options.childRead === 'project-env') {
    fs.writeFileSync(envFile, `SECRET=${ENV_FILE_MARKER}\n`)
  }
  if (options.plantSkill === true) {
    const skillDir = path.join(
      fixture.projectDir,
      '.opencode/skills',
      PLANTED_SKILL_ID,
    )
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${PLANTED_SKILL_ID}\ndescription: A planted skill for the offered-tools proof\n---\n\n${PLANTED_SKILL_MARKER}\n`,
    )
  }
  if (options.systematicConfig !== undefined) {
    fs.writeFileSync(
      path.join(fixture.configDir, 'systematic.json'),
      JSON.stringify(options.systematicConfig),
    )
  }

  const dispatchArguments =
    host === 'v2' ? { agent: options.agent } : { subagent_type: options.agent }
  const script = createReviewerOfferScript({
    dispatch: {
      tool: tools.dispatch,
      arguments: {
        ...dispatchArguments,
        description: 'Read the note',
        prompt: `${CHILD_PROMPT_MARK} Read the note and report.`,
      },
    },
    childCall: options.childCall ?? {
      tool: tools.read,
      arguments: {
        [tools.readPathKey]:
          options.childRead === 'project-env' ? envFile : externalNote,
      },
    },
    isChildRequest: (request) => {
      const user = lastUserTextOf(request)
      return (
        user.includes(CHILD_PROMPT_MARK) && !user.includes(PARENT_DIRECTIVE)
      )
    },
  })
  const model = startScriptedModel(script)
  try {
    const configContent = withScriptedProvider(
      JSON.stringify({
        plugin: [pluginSpec],
        snapshot: false,
        ...options.hostConfig,
      }),
      model.url,
      host,
    )
    writeHostProjectConfig(fixture, configContent, host)
    const result = await spawnOpencodeChild(
      buildOpencodeRunArgv(
        host,
        `${PARENT_DIRECTIVE} Dispatch ${options.agent} to read the note.`,
      ),
      {
        cwd: fixture.projectDir,
        env: buildIsolatedOpencodeEnv(fixture, configContent, undefined, host),
        timeoutMs: TIMEOUT_MS,
      },
    )
    const seen = script.observation()
    const lastChild = seen.childRequests.at(-1)
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      requestCount: seen.requestCount,
      parentOffered: toolNamesOf(seen.parentRequests[0] ?? {}),
      childOffered: toolNamesOf(seen.childRequests[0] ?? {}),
      childRequestCount: seen.childRequests.length,
      childIsAgent:
        seen.childRequests.length > 0 &&
        seen.childRequests.every((request) =>
          hasResearcherSystemMarker(request, options.marker),
        ),
      childCallResult:
        lastChild === undefined ? undefined : toolResultsOf(lastChild)[0],
    }
  } finally {
    model.stop()
  }
}

// ── The assertions ───────────────────────────────────────────────────────────

function sorted(names: readonly string[]): string[] {
  return [...names].sort()
}

/** Why a run does not show a dispatched agent at all, or an empty list when it does. */
function runFailures(run: ReviewerOfferRun): string[] {
  const failures: string[] = []
  if (run.parentOffered.length === 0) {
    failures.push('the parent made no request that offered tools')
  }
  if (run.childRequestCount === 0) {
    failures.push('no request from the dispatched child was seen')
  } else if (!run.childIsAgent) {
    failures.push('a child request did not carry the dispatched agent marker')
  }
  return failures
}

/**
 * Reasons a dispatched review agent's offer differs from the deny list's
 * intent, or an empty list when it holds. `control` is the same run for an
 * agent with no permission block: the reviewer child must be offered exactly
 * what the control child is, less the withheld tools. A tool the deny list
 * does not name stays offered, so an unlisted tool is never a failure on its
 * own. A tolerated tool is neither required nor forbidden on either side.
 */
export function reviewerOfferFailures(
  host: ReviewerHost,
  reviewer: ReviewerOfferRun,
  control: ReviewerOfferRun,
): string[] {
  const failures = [...runFailures(reviewer), ...runFailures(control)]
  if (failures.length > 0) return failures
  const tools = REVIEWER_HOST_TOOLS[host]
  const withheld = REVIEWER_WITHHELD_TOOLS[host]
  const withheldNames: readonly string[] = [
    ...withheld.checkedOnParent,
    ...withheld.childOnly,
  ]

  const offeredWithheld = withheldNames.filter((name) =>
    reviewer.childOffered.includes(name),
  )
  if (offeredWithheld.length > 0) {
    failures.push(
      `the reviewer child is offered ${sorted(offeredWithheld).join(', ')}`,
    )
  }
  const notOnParent = withheld.checkedOnParent.filter(
    (name) => !reviewer.parentOffered.includes(name),
  )
  if (notOnParent.length > 0) {
    failures.push(
      `the parent is not offered ${notOnParent.join(', ')}, so withholding them from the child proves nothing`,
    )
  }
  const notOnControl = [tools.read, tools.grep, tools.glob, tools.shell].filter(
    (name) => !control.childOffered.includes(name),
  )
  if (notOnControl.length > 0) {
    failures.push(
      `the control child is not offered ${notOnControl.join(', ')}, so keeping them proves nothing`,
    )
  }

  const expected = withoutTolerated(host, control.childOffered).filter(
    (name) => !withheldNames.includes(name),
  )
  const actual = withoutTolerated(host, reviewer.childOffered)
  const missing = expected.filter((name) => !actual.includes(name))
  if (missing.length > 0) {
    failures.push(
      `the reviewer child is not offered what the control child is: ${sorted(missing).join(', ')}`,
    )
  }
  const extra = actual.filter(
    (name) => !expected.includes(name) && !withheldNames.includes(name),
  )
  if (extra.length > 0) {
    failures.push(
      `the reviewer child is offered what the control child is not: ${sorted(extra).join(', ')}`,
    )
  }
  return failures
}

export interface ReadOutcome {
  /** The result held the planted file's text. */
  returned: boolean
  /** The host asked for permission (a headless run prints the request and rejects it). */
  permissionRequested: boolean
  /**
   * The child got a tool result back. A headless run that auto-rejects a
   * permission request ends the child before it gets one.
   */
  resultReceived: boolean
  /** The child's result text, or a note that it received none. */
  result: string
}

/** What the child's read call did, judged by whether the planted `marker` came back. */
export function readOutcome(
  run: ReviewerOfferRun,
  marker: string,
): ReadOutcome {
  const result = run.childCallResult ?? 'the child received no tool result'
  return {
    returned: result.includes(marker),
    permissionRequested: /permission requested/.test(run.stderr),
    resultReceived: run.childCallResult !== undefined,
    result,
  }
}

/** One line naming a read outcome, for a failure message. */
export function describeReadOutcome(outcome: ReadOutcome): string {
  const asked = outcome.permissionRequested ? 'asked for permission' : 'no ask'
  return `${outcome.returned ? 'returned the file' : 'did not return the file'}, ${asked}: ${outcome.result}`
}

/**
 * Reasons the reviewer's read ended differently from the control agent's read
 * of the same kind of file, or an empty list when the outcomes match. The
 * reviewer's block sets nothing for `read` or `external_directory`, so the
 * host's own rules decide both reads the same way for both agents. A control
 * read that neither returned the file, nor was asked about, nor got a result
 * shows nothing, so it fails.
 */
export function readParityFailures(
  reviewer: ReviewerOfferRun,
  control: ReviewerOfferRun,
  marker: string,
): string[] {
  const failures = [...runFailures(reviewer), ...runFailures(control)]
  if (failures.length > 0) return failures
  const reviewerOutcome = readOutcome(reviewer, marker)
  const controlOutcome = readOutcome(control, marker)
  if (
    !controlOutcome.returned &&
    !controlOutcome.permissionRequested &&
    !controlOutcome.resultReceived
  ) {
    return ['the control read shows nothing: no file, no ask, no result']
  }
  if (
    reviewerOutcome.returned !== controlOutcome.returned ||
    reviewerOutcome.permissionRequested !==
      controlOutcome.permissionRequested ||
    reviewerOutcome.resultReceived !== controlOutcome.resultReceived
  ) {
    failures.push(
      `the reviewer's read differs from the control's. reviewer: ${describeReadOutcome(reviewerOutcome)}. control: ${describeReadOutcome(controlOutcome)}`,
    )
  }
  return failures
}

/** Reasons the child's read of a file outside the project did not return the file, or an empty list when it did. */
export function externalReadFailures(run: ReviewerOfferRun): string[] {
  const failures = runFailures(run)
  if (failures.length > 0) return failures
  if (/permission requested/.test(run.stderr)) {
    failures.push(
      `the host asked for permission to read outside the project: ${run.stderr
        .split('\n')
        .filter((line) => /permission requested/.test(line))
        .join(' ')}`,
    )
  }
  if (!(run.childCallResult ?? '').includes(EXTERNAL_NOTE_MARKER)) {
    failures.push(
      `the read outside the project did not return the file: ${run.childCallResult ?? 'the child received no tool result'}`,
    )
  }
  return failures
}

/**
 * Reasons the child's `skill` call for the planted skill returned its body, or
 * an empty list when it was refused or the tool was unavailable.
 */
export function skillCallFailures(run: ReviewerOfferRun): string[] {
  const failures = runFailures(run)
  if (failures.length > 0) return failures
  const result = run.childCallResult
  if (result === undefined) {
    return ['the child received no result for its skill call']
  }
  if (result.includes(PLANTED_SKILL_MARKER)) {
    failures.push('the skill call returned the planted skill body')
  } else if (
    !/Permission denied: skill|No tool named \\?"skill\\?"/.test(result)
  ) {
    failures.push(
      `the skill call was neither refused nor unavailable: ${result}`,
    )
  }
  return failures
}

/**
 * Reasons a control agent with no permission block is not offered the same
 * tools as the parent, apart from those the host takes from every child, or
 * an empty list when it is.
 */
export function controlOfferFailures(
  host: ReviewerHost,
  run: ReviewerOfferRun,
): string[] {
  const failures = runFailures(run)
  if (failures.length > 0) return failures
  const hostWithheld: readonly string[] = HOST_SUBAGENT_WITHHELD[host]
  const missing = run.parentOffered.filter(
    (name) => !hostWithheld.includes(name) && !run.childOffered.includes(name),
  )
  const extra = run.childOffered.filter(
    (name) => !run.parentOffered.includes(name),
  )
  if (missing.length > 0) {
    failures.push(
      `the control child is not offered what the parent is: ${sorted(missing).join(', ')}`,
    )
  }
  if (extra.length > 0) {
    failures.push(
      `the control child is offered what the parent is not: ${sorted(extra).join(', ')}`,
    )
  }
  return failures
}
