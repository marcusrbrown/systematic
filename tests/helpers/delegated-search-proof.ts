/**
 * Proof that a delegated researcher can reach `systematic_search` on a real
 * host, shared by the OpenCode v1, OpenCode v2 and Pi integration files.
 *
 * One proof applies to every host: the researcher child's next model request
 * carries a `role: tool` message that starts with `Search "`, is not an
 * `Error:`, and holds both planted documents. The child searches every kind, so
 * the abandoned brainstorm must be there too, printed with `Kind: brainstorm`
 * and `Status: abandoned` on its own hit. The parent's final request must carry
 * both paths. Whether the tool was advertised to the child's first request is
 * only a diagnostic: it names the failure when delivery fails, and never makes
 * a run pass.
 *
 * The scripted model is the same on every host. It runs four turns: the parent
 * dispatches the researcher, the child calls the search tool, the child answers
 * with the paths it read from the real tool message, and the parent answers
 * with the paths it read from the real dispatch result. Because both answers
 * are read back from what the host sent, a final answer that names the paths
 * means the real result went all the way through.
 *
 * What this does not prove: a live model choosing to call the tool. The
 * scripted model makes the call.
 */
import fs from 'node:fs'
import path from 'node:path'

import { SEARCH_TOOL_NAME } from '../../src/lib/search-core.js'

// ── Planted fixture ──────────────────────────────────────────────────────────

/** The one place the planted documents and the scripted search are named. */
export const DELEGATED_SEARCH_FIXTURE = {
  solution: {
    path: 'docs/solutions/zebra-flake.md',
    content:
      '---\ntitle: Zebra crossing flake\nsymptoms:\n  - zebra flake on retry\n---\n\nThe zebra flake appears when retries overlap.\n',
  },
  /** Found only when the search covers every kind; a solution-only search never reads it. */
  brainstorm: {
    path: 'docs/brainstorms/2026-01-15-zebra-crossing-requirements.md',
    kind: 'brainstorm',
    status: 'abandoned',
    content:
      '---\ndate: 2026-01-15\ntopic: zebra-crossing\nstatus: abandoned\n---\n\n# Zebra crossing\n\nAn abandoned idea: retry the zebra flake with a longer delay.\n',
  },
  /** What the scripted child sends to the search tool. */
  searchArguments: { query: 'zebra flake retry', kind: 'all' },
  /** The researcher agent file, relative to the repository root. */
  researcherAgentFile: 'agents/research/learnings-researcher.md',
} as const

/**
 * The most model requests one scripted run may make. A passing run makes five
 * on OpenCode (one is the session title) and four on Pi, so ten leaves room
 * for a stray retry and still stops a runaway loop within seconds.
 */
export const DELEGATED_SEARCH_REQUEST_CAP = 10

/** Writes the planted solution and brainstorm under a fixture project. */
export function plantDelegatedSearchFixture(projectDir: string): void {
  for (const doc of [
    DELEGATED_SEARCH_FIXTURE.solution,
    DELEGATED_SEARCH_FIXTURE.brainstorm,
  ]) {
    const target = path.join(projectDir, doc.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, doc.content)
  }
}

/**
 * The researcher's own opening line, read from its agent file so the marker
 * cannot drift from the agent. Every host puts the agent body into the child's
 * system prompt, and the parent's system prompt never contains it.
 */
export function researcherSystemMarker(repoRoot: string): string {
  const raw = fs.readFileSync(
    path.join(repoRoot, DELEGATED_SEARCH_FIXTURE.researcherAgentFile),
    'utf8',
  )
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '')
  const line = body.split('\n').find((candidate) => candidate.trim() !== '')
  if (line === undefined) throw new Error('researcher agent file has no body')
  return line.slice(0, 80)
}

// ── Reading a recorded chat request ──────────────────────────────────────────

/** The parts of an OpenAI-compatible chat request the proof reads. */
export interface ChatRequest {
  tools?: unknown[]
  messages?: unknown[]
}

export function roleOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const role = (message as { role?: unknown }).role
  return typeof role === 'string' ? role : undefined
}

export function messageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const text = (part as { text?: unknown } | null)?.text
      return typeof text === 'string' ? text : ''
    })
    .join('\n')
}

export function toolNamesOf(request: ChatRequest): string[] {
  const names: string[] = []
  for (const tool of request.tools ?? []) {
    const name = (tool as { function?: { name?: unknown } } | null)?.function
      ?.name
    if (typeof name === 'string') names.push(name)
  }
  return names
}

/** System and developer messages joined; hosts differ on which role carries the prompt. */
export function systemTextOf(request: ChatRequest): string {
  return (request.messages ?? [])
    .filter((m) => roleOf(m) === 'system' || roleOf(m) === 'developer')
    .map((m) => messageText(m))
    .join('\n')
}

export function lastUserTextOf(request: ChatRequest): string {
  const user = [...(request.messages ?? [])]
    .reverse()
    .find((m) => roleOf(m) === 'user')
  return messageText(user)
}

function lastMessageRole(request: ChatRequest): string | undefined {
  return roleOf((request.messages ?? []).at(-1))
}

function lastToolText(request: ChatRequest): string | undefined {
  const tools = (request.messages ?? []).filter((m) => roleOf(m) === 'tool')
  const last = tools.at(-1)
  return last === undefined ? undefined : messageText(last)
}

/** True when the request is the researcher child's, judged by its system prompt. */
export function hasResearcherSystemMarker(
  request: ChatRequest,
  marker: string,
): boolean {
  return systemTextOf(request).includes(marker)
}

// ── The proof ────────────────────────────────────────────────────────────────

export type DelegatedSearchFailureCode =
  | 'request-cap'
  | 'no-child-request'
  | 'tool-not-advertised'
  | 'no-tool-call'
  | 'error-result'
  | 'bad-header'
  | 'path-missing'
  | 'bad-label'
  | 'no-parent-final'
  | 'parent-answer-missing-path'

export type DelegatedSearchVerdict =
  | { ok: true }
  | { ok: false; code: DelegatedSearchFailureCode; message: string }

export interface DelegatedSearchObservation {
  /** Every model request the host made, titles included. */
  requestCount: number
  requestCap: number
  /** The researcher child's requests, in order. */
  childRequests: readonly ChatRequest[]
  /** The parent's requests, in order. */
  parentRequests: readonly ChatRequest[]
  /** The solution path the child must have found. Defaults to the planted solution. */
  plantedPath?: string
  /** The brainstorm path the child must have found. Defaults to the planted brainstorm. */
  plantedBrainstormPath?: string
}

const SEARCH_HEADER_PREFIX = 'Search "'
/** What the renderer joins a hit's label fields with. */
const HIT_FIELD_SEPARATOR = ' | '

function fail(
  code: DelegatedSearchFailureCode,
  message: string,
): DelegatedSearchVerdict {
  return { ok: false, code, message }
}

/**
 * Names why delivery failed. Reads the child's first request only; it never
 * turns a failure into a pass.
 */
function diagnoseMissingDelivery(first: ChatRequest): DelegatedSearchVerdict {
  const offered = toolNamesOf(first)
  if (!offered.includes(SEARCH_TOOL_NAME)) {
    return fail(
      'tool-not-advertised',
      `the researcher child's first request did not advertise ${SEARCH_TOOL_NAME} (tools offered: ${offered.join(', ') || 'none'})`,
    )
  }
  return fail(
    'no-tool-call',
    `the researcher child answered without calling ${SEARCH_TOOL_NAME}, so it fell back to its other tools`,
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The `Kind:` and `Status:` fields the renderer prints on the line right after
 * a hit's `N. <path>` line, or `undefined` when that path heads no hit (it may
 * only be quoted in a snippet) or the output was cut before the label line.
 */
function hitLabels(
  toolText: string,
  hitPath: string,
): readonly string[] | undefined {
  const heading = new RegExp(`^\\d+\\. ${escapeRegExp(hitPath)}$`)
  const lines = toolText.split('\n')
  const at = lines.findIndex((line) => heading.test(line))
  const labelLine = at === -1 ? undefined : lines[at + 1]
  if (labelLine === undefined) return undefined
  return labelLine.trim().split(HIT_FIELD_SEPARATOR)
}

/** Checks the child's tool message: a search result holding both planted hits. */
function checkChildResult(
  toolText: string,
  plantedPaths: readonly string[],
  brainstormPath: string,
): DelegatedSearchVerdict | undefined {
  if (toolText.startsWith('Error:')) {
    return fail(
      'error-result',
      `the child's tool message is an error: ${toolText.slice(0, 160)}`,
    )
  }
  if (!toolText.startsWith(SEARCH_HEADER_PREFIX)) {
    return fail(
      'bad-header',
      `the child's tool message does not start with ${SEARCH_HEADER_PREFIX}: ${toolText.slice(0, 160)}`,
    )
  }
  const absent = plantedPaths.find((planted) => !toolText.includes(planted))
  if (absent !== undefined) {
    return fail(
      'path-missing',
      `the child's tool message does not contain ${absent}: ${toolText.slice(0, 160)}`,
    )
  }
  const printed = hitLabels(toolText, brainstormPath)
  const missingLabels = [
    `Kind: ${DELEGATED_SEARCH_FIXTURE.brainstorm.kind}`,
    `Status: ${DELEGATED_SEARCH_FIXTURE.brainstorm.status}`,
  ].filter((label) => !printed?.includes(label))
  if (missingLabels.length > 0) {
    return fail(
      'bad-label',
      `the hit for ${brainstormPath} does not print ${missingLabels.join(' and ')} (printed: ${printed?.join(HIT_FIELD_SEPARATOR) ?? 'no hit line'})`,
    )
  }
  return undefined
}

/** Checks that the parent's last request carries every planted path. */
function checkParentFinal(
  parentRequests: readonly ChatRequest[],
  plantedPaths: readonly string[],
): DelegatedSearchVerdict | undefined {
  const lastParent = parentRequests.at(-1)
  if (lastParent === undefined || lastMessageRole(lastParent) !== 'tool') {
    return fail(
      'no-parent-final',
      "the parent never made a request after the researcher's result came back",
    )
  }
  const parentText = lastToolText(lastParent) ?? ''
  const absent = plantedPaths.find((planted) => !parentText.includes(planted))
  return absent === undefined
    ? undefined
    : fail(
        'parent-answer-missing-path',
        `the parent's final request does not carry ${absent}`,
      )
}

/** Applies the single delivery proof to what a scripted run recorded. */
export function evaluateDelegatedSearchProof(
  observation: DelegatedSearchObservation,
): DelegatedSearchVerdict {
  const brainstormPath =
    observation.plantedBrainstormPath ??
    DELEGATED_SEARCH_FIXTURE.brainstorm.path
  const plantedPaths = [
    observation.plantedPath ?? DELEGATED_SEARCH_FIXTURE.solution.path,
    brainstormPath,
  ]
  const { childRequests, parentRequests } = observation

  if (observation.requestCount > observation.requestCap) {
    return fail(
      'request-cap',
      `the model received ${observation.requestCount} requests, over the cap of ${observation.requestCap}; the script is looping`,
    )
  }
  const first = childRequests[0]
  if (first === undefined) {
    return fail(
      'no-child-request',
      'no request from the researcher child was seen, so the parent never dispatched it',
    )
  }

  const delivered = childRequests.find(
    (request) => lastMessageRole(request) === 'tool',
  )
  const toolText = delivered === undefined ? undefined : lastToolText(delivered)
  if (toolText === undefined) return diagnoseMissingDelivery(first)

  return (
    checkChildResult(toolText, plantedPaths, brainstormPath) ??
    checkParentFinal(parentRequests, plantedPaths) ?? { ok: true }
  )
}

/** Throws the verdict's message when the proof fails. */
export function assertDelegatedSearchProof(
  observation: DelegatedSearchObservation,
): void {
  const verdict = evaluateDelegatedSearchProof(observation)
  if (!verdict.ok) {
    throw new Error(
      `delegated search proof failed [${verdict.code}]: ${verdict.message}`,
    )
  }
}

// ── The scripted model ───────────────────────────────────────────────────────

export type ScriptedTurn =
  | { text: string }
  | {
      toolCalls: {
        id: string
        name: string
        arguments: Record<string, unknown>
      }[]
    }

export interface DelegatedSearchScriptOptions {
  /** How the parent calls the researcher on this host. */
  dispatch: { tool: string; arguments: Record<string, unknown> }
  /** Tells the researcher child's requests from the parent's on this host. */
  isChildRequest: (request: ChatRequest) => boolean
  requestCap?: number
}

export interface DelegatedSearchScript {
  /** The scripted answer for the next request. */
  respond(request: ChatRequest): ScriptedTurn
  /** What the run recorded, ready for the proof. */
  observation(): DelegatedSearchObservation
}

const PATH_PATTERN = /docs\/[a-z]+\/[\w.-]+\.md/g

/**
 * Each distinct path in the request's latest tool result, in the order they
 * appear, or a marker when there is none.
 */
function pathsInLastResult(request: ChatRequest): string {
  const found = new Set(lastToolText(request)?.match(PATH_PATTERN))
  return found.size === 0 ? 'NO-PATH' : [...found].join(' ')
}

function childTurn(request: ChatRequest): ScriptedTurn {
  if (lastMessageRole(request) === 'tool') {
    return { text: `CHILD-FOUND ${pathsInLastResult(request)}` }
  }
  if (!toolNamesOf(request).includes(SEARCH_TOOL_NAME)) {
    return { text: 'CHILD-ANSWERED-WITHOUT-SEARCH' }
  }
  return {
    toolCalls: [
      {
        id: 'delegated-search-call',
        name: SEARCH_TOOL_NAME,
        arguments: { ...DELEGATED_SEARCH_FIXTURE.searchArguments },
      },
    ],
  }
}

/**
 * A small state machine over the four scripted turns. A request that offers no
 * tools is the session title. Otherwise the host's own filter says whether the
 * request is the child's; the parent dispatches once and then answers with the
 * path in the result it was handed.
 */
export function createDelegatedSearchScript(
  options: DelegatedSearchScriptOptions,
): DelegatedSearchScript {
  const requestCap = options.requestCap ?? DELEGATED_SEARCH_REQUEST_CAP
  const childRequests: ChatRequest[] = []
  const parentRequests: ChatRequest[] = []
  let requestCount = 0
  let dispatched = false

  function parentTurn(request: ChatRequest): ScriptedTurn {
    if (lastMessageRole(request) === 'tool') {
      return { text: `PARENT-FINAL ${pathsInLastResult(request)}` }
    }
    if (dispatched) return { text: 'PARENT-UNEXPECTED-TURN' }
    dispatched = true
    return {
      toolCalls: [
        {
          id: 'delegated-dispatch-call',
          name: options.dispatch.tool,
          arguments: { ...options.dispatch.arguments },
        },
      ],
    }
  }

  function respond(request: ChatRequest): ScriptedTurn {
    requestCount += 1
    if (requestCount > requestCap) return { text: 'REQUEST-CAP-EXCEEDED' }
    if (toolNamesOf(request).length === 0) return { text: 'Scripted title' }
    if (options.isChildRequest(request)) {
      childRequests.push(request)
      return childTurn(request)
    }
    parentRequests.push(request)
    return parentTurn(request)
  }

  return {
    respond,
    observation: () => ({
      requestCount,
      requestCap,
      childRequests: [...childRequests],
      parentRequests: [...parentRequests],
    }),
  }
}
