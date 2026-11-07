/**
 * Proof that a dispatched researcher cannot use shell, write or web tools on a
 * real host, shared by the OpenCode v1 and v2 integration files.
 *
 * A scripted model drives a parent that dispatches the researcher child. The
 * child then tries, in order: a shell write, a file write, an edit of a planted
 * file, a web fetch against a local counting server, and finally a read of a
 * planted note. The first four must be refused and the read must succeed. The
 * proof reads the result from three places, so no single signal can pass it:
 *
 * - the tool result each attempt received (a refusal, or a result that shows
 *   the tool ran),
 * - the disk and the fetch server (nothing was written, edited or fetched),
 * - the parent's final answer (the planted marker the read returned made the
 *   whole round trip).
 *
 * A negative control runs the same script against a definition with the deny
 * entries removed. It must fail with the named `isolation-breach` code while
 * the child is still reached, so the proof cannot pass by never exercising the
 * tools.
 *
 * What this does not prove: a live model choosing to call these tools. The
 * scripted model makes every call, so the proof shows what the host enforces.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  type ChatRequest,
  lastUserTextOf,
  messageText,
  roleOf,
  toolNamesOf,
} from './delegated-search-proof.js'

export type { ChatRequest }
export { lastUserTextOf, messageText, roleOf, toolNamesOf }

// ── Planted fixture ──────────────────────────────────────────────────────────

/** The text the planted note carries and the whole chain must hand back. */
export const CONNECT_PROBE_MARKER = 'CONNECT-PROBE-MARKER-7f3a'

const MARKER_PATTERN = /CONNECT-PROBE-MARKER-\w+/

/** What the scripted parent's final answer starts with, ahead of the marker. */
export const CONNECT_PARENT_FINAL = 'PARENT-FINAL'

/** What the scripted child's last message starts with, ahead of the marker. */
export const CONNECT_CHILD_FINAL = 'CHILD-FOUND'

/**
 * Model requests one scripted run may make. A passing run makes about seven on
 * OpenCode (the title request included), so sixteen leaves room for a retry and
 * still stops a runaway loop within seconds.
 */
export const CONNECT_REQUEST_CAP = 16

export interface ConnectIsolationLayout {
  readonly projectDir: string
  /** The planted note the child reads; holds {@link CONNECT_PROBE_MARKER}. */
  readonly readTarget: string
  /** Where the denied shell command would write. Must never exist. */
  readonly shellMarker: string
  /** Where the denied write would create a file. Must never exist. */
  readonly writeMarker: string
  /** A planted file the denied edit would change. Must stay as planted. */
  readonly editTarget: string
}

const EDIT_TARGET_ORIGINAL = 'ORIGINAL-CONTENT'

export function connectIsolationLayout(
  projectDir: string,
): ConnectIsolationLayout {
  return {
    projectDir,
    readTarget: path.join(projectDir, 'docs/solutions/probe-note.md'),
    shellMarker: path.join(projectDir, 'isolation/shell-marker.txt'),
    writeMarker: path.join(projectDir, 'isolation/write-marker.txt'),
    editTarget: path.join(projectDir, 'isolation/edit-target.txt'),
  }
}

/** Plants the note to read and the file the denied edit would change. */
export function plantConnectIsolationFixture(
  layout: ConnectIsolationLayout,
): void {
  fs.mkdirSync(path.dirname(layout.readTarget), { recursive: true })
  fs.writeFileSync(
    layout.readTarget,
    `---\ntitle: Probe note\n---\n\n${CONNECT_PROBE_MARKER}\n`,
  )
  fs.mkdirSync(path.dirname(layout.editTarget), { recursive: true })
  fs.writeFileSync(layout.editTarget, EDIT_TARGET_ORIGINAL)
}

/**
 * Plants a small git checkout outside the project and returns a layout whose
 * read target is the note inside it. A read of that note is a read of another
 * project's files, which is what the researcher does on a real run.
 */
function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'probe',
      GIT_AUTHOR_EMAIL: 'probe@example.invalid',
      GIT_COMMITTER_NAME: 'probe',
      GIT_COMMITTER_EMAIL: 'probe@example.invalid',
    },
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

function commitAll(dir: string): void {
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'probe'])
}

/**
 * Makes a planted project a committed git repository, so a call that adds a git
 * worktree to it has something to act on and can be seen.
 */
export function plantConnectGitRepo(projectDir: string): void {
  commitAll(projectDir)
}

export function plantConnectExternalCheckout(
  layout: ConnectIsolationLayout,
  checkoutDir: string,
): ConnectIsolationLayout {
  const note = path.join(checkoutDir, 'docs/solutions/external-note.md')
  fs.mkdirSync(path.dirname(note), { recursive: true })
  fs.writeFileSync(
    note,
    `---\ntitle: External note\n---\n\n${CONNECT_PROBE_MARKER}\n`,
  )
  commitAll(checkoutDir)
  return { ...layout, readTarget: note }
}

export interface ConnectSideEffects {
  /** Marker files that exist after the run. Any entry is a breach. */
  readonly writtenPaths: readonly string[]
  /** True when the planted edit target no longer holds its planted text. */
  readonly editTargetChanged: boolean
  /** Requests the local fetch server received. */
  readonly fetchHits: number
  /** Git worktrees added to the project beyond its own checkout. */
  readonly extraWorktrees: number
}

function countExtraWorktrees(projectDir: string): number {
  if (!fs.existsSync(path.join(projectDir, '.git'))) return 0
  const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: projectDir,
    encoding: 'utf8',
  })
  if (listed.status !== 0) return 0
  const count = listed.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length
  return Math.max(0, count - 1)
}

export function readConnectSideEffects(
  layout: ConnectIsolationLayout,
  fetchHits: number,
): ConnectSideEffects {
  const editText = fs.existsSync(layout.editTarget)
    ? fs.readFileSync(layout.editTarget, 'utf8')
    : undefined
  return {
    writtenPaths: [layout.shellMarker, layout.writeMarker].filter((file) =>
      fs.existsSync(file),
    ),
    editTargetChanged: editText !== EDIT_TARGET_ORIGINAL,
    fetchHits,
    extraWorktrees: countExtraWorktrees(layout.projectDir),
  }
}

// ── The researcher definition under test ─────────────────────────────────────

/** Matches the `permission:` block of a definition's frontmatter. */
const PERMISSION_BLOCK = /^permission:\n(?:[ \t]+.*\n)+/m

/** The actions a definition's `permission:` block sets to `deny`. */
export function parseDenyBlock(definition: string): string[] {
  const block = PERMISSION_BLOCK.exec(definition)?.[0]
  if (block === undefined) return []
  return [...block.matchAll(/^[ \t]+(\w+):\s*deny\s*$/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  )
}

/**
 * The definition without its `permission:` block, for the negative control.
 * Throws when there is nothing to remove, so a control cannot pass vacuously
 * against a definition that never denied anything.
 */
export function withoutDenyEntries(definition: string): string {
  if (parseDenyBlock(definition).length === 0) {
    throw new Error('definition has no permission block with deny entries')
  }
  return definition.replace(PERMISSION_BLOCK, '')
}

/**
 * The definition without its `external_directory: allow` entry, for the control
 * that shows the entry is what lets a read leave the working directory. Throws
 * when the entry is absent, so the control cannot pass vacuously.
 */
export function withoutExternalDirectoryAllow(definition: string): string {
  const stripped = definition.replace(
    /^[ \t]+external_directory:\s*allow\s*\n/m,
    '',
  )
  if (stripped === definition) {
    throw new Error('definition has no external_directory allow entry')
  }
  return stripped
}

// ── The proof ────────────────────────────────────────────────────────────────

export type IsolationAttemptLabel =
  | 'shell'
  | 'write'
  | 'edit'
  | 'webfetch'
  | 'execute'
  | 'websearch'
  | 'read'

/**
 * The tool names a host registers for each capability. `execute` (a scripting
 * runtime with its own HTTP client) and `websearch` exist on some hosts only;
 * a host lists them to have the child try them too.
 */
export type IsolationHostTools = Readonly<
  Record<'shell' | 'write' | 'edit' | 'webfetch' | 'read', string>
> &
  Readonly<Partial<Record<'execute' | 'websearch', string>>>

export type ConnectIsolationFailureCode =
  | 'request-cap'
  | 'no-child-request'
  | 'isolation-breach'
  | 'attempts-incomplete'
  | 'attempt-ran'
  | 'read-not-delivered'
  | 'no-parent-final'
  | 'no-final-answer'
  | 'final-answer-missing-marker'

export type ConnectIsolationVerdict =
  | { ok: true }
  | { ok: false; code: ConnectIsolationFailureCode; message: string }

export interface ConnectIsolationObservation {
  requestCount: number
  requestCap: number
  /** The researcher child's requests, in order. */
  childRequests: readonly ChatRequest[]
  /** The parent's requests, in order. */
  parentRequests: readonly ChatRequest[]
  /** The attempts the child scripted, in order. The read is the last. */
  attempts: readonly IsolationAttemptLabel[]
  sideEffects: ConnectSideEffects
  /** The parent's final assistant message as the host returned it. */
  parentAnswer?: string
}

/**
 * What a refused call looks like to the model across hosts: the permission
 * rule text, a tool the host did not offer, or a plain denial. A tool that ran
 * returns its own output, which holds none of these words.
 */
const REFUSAL_PATTERN =
  /permission|denied|deny|rejected|prevents you|unavailable tool|not available|no tool named|disabled|not allowed|blocked/i

function fail(
  code: ConnectIsolationFailureCode,
  message: string,
): ConnectIsolationVerdict {
  return { ok: false, code, message }
}

function lastMessageRole(request: ChatRequest): string | undefined {
  return roleOf((request.messages ?? []).at(-1))
}

function toolResultsOf(request: ChatRequest): string[] {
  return (request.messages ?? [])
    .filter((message) => roleOf(message) === 'tool')
    .map((message) => messageText(message))
}

function describeBreach(effects: ConnectSideEffects): string | undefined {
  const parts: string[] = []
  if (effects.writtenPaths.length > 0) {
    parts.push(
      `files exist that a denied call would create: ${effects.writtenPaths.join(', ')}`,
    )
  }
  if (effects.editTargetChanged) {
    parts.push('the planted edit target changed')
  }
  if (effects.fetchHits > 0) {
    parts.push(`the web fetch reached the server ${effects.fetchHits} time(s)`)
  }
  if (effects.extraWorktrees > 0) {
    parts.push(
      `${effects.extraWorktrees} git worktree(s) were added to the project`,
    )
  }
  return parts.length === 0 ? undefined : parts.join('; ')
}

function checkAttempts(
  attempts: readonly IsolationAttemptLabel[],
  results: readonly string[],
): ConnectIsolationVerdict | undefined {
  if (results.length < attempts.length) {
    return fail(
      'attempts-incomplete',
      `the child received ${results.length} tool result(s) for ${attempts.length} attempts`,
    )
  }
  for (const [index, label] of attempts.entries()) {
    const text = results[index] ?? ''
    if (label === 'read') {
      if (!text.includes(CONNECT_PROBE_MARKER) || text.startsWith('Error:')) {
        return fail(
          'read-not-delivered',
          `the read did not return the planted marker: ${text.slice(0, 160)}`,
        )
      }
    } else if (!REFUSAL_PATTERN.test(text)) {
      return fail(
        'attempt-ran',
        `the ${label} call was not refused (result: ${text.slice(0, 160)})`,
      )
    }
  }
  return undefined
}

function checkParentFinal(
  parentRequests: readonly ChatRequest[],
  parentAnswer: string | undefined,
): ConnectIsolationVerdict | undefined {
  const last = parentRequests.at(-1)
  if (last === undefined || lastMessageRole(last) !== 'tool') {
    return fail(
      'no-parent-final',
      "the parent never made a request after the researcher's result came back",
    )
  }
  if (
    parentAnswer === undefined ||
    !parentAnswer.includes(CONNECT_PARENT_FINAL)
  ) {
    return fail(
      'no-final-answer',
      `the host's final assistant message does not hold ${CONNECT_PARENT_FINAL}: ${parentAnswer?.slice(0, 160) ?? 'no message was captured'}`,
    )
  }
  return parentAnswer.includes(CONNECT_PROBE_MARKER)
    ? undefined
    : fail(
        'final-answer-missing-marker',
        `the host's final assistant message does not carry the planted marker: ${parentAnswer.slice(0, 160)}`,
      )
}

/**
 * The part of the proof that concerns the researcher alone: the model was not
 * looping, the child was reached, nothing reached disk or the fetch server, the
 * four denied calls were refused and the read succeeded. A session that runs
 * the researcher directly, with no parent, is judged by this alone.
 */
export function evaluateConnectChildAttempts(
  observation: Omit<ConnectIsolationObservation, 'parentAnswer'>,
): ConnectIsolationVerdict {
  const { childRequests, attempts } = observation
  if (observation.requestCount > observation.requestCap) {
    return fail(
      'request-cap',
      `the model received ${observation.requestCount} requests, over the cap of ${observation.requestCap}; the script is looping`,
    )
  }
  if (childRequests.length === 0) {
    return fail(
      'no-child-request',
      'no request from the researcher child was seen, so the parent never dispatched it',
    )
  }
  const breach = describeBreach(observation.sideEffects)
  if (breach !== undefined) return fail('isolation-breach', breach)

  // The last child request carries the whole history, so it holds every result.
  const fullest = [...childRequests].sort(
    (a, b) => toolResultsOf(b).length - toolResultsOf(a).length,
  )[0]
  const results = fullest === undefined ? [] : toolResultsOf(fullest)

  return checkAttempts(attempts, results) ?? { ok: true }
}

/** Applies the isolation proof to what a scripted run recorded. */
export function evaluateConnectIsolationProof(
  observation: ConnectIsolationObservation,
): ConnectIsolationVerdict {
  const childVerdict = evaluateConnectChildAttempts(observation)
  if (!childVerdict.ok) return childVerdict
  return (
    checkParentFinal(observation.parentRequests, observation.parentAnswer) ?? {
      ok: true,
    }
  )
}

/** Throws the verdict's message when the proof fails. */
export function assertConnectIsolationProof(
  observation: ConnectIsolationObservation,
): void {
  const verdict = evaluateConnectIsolationProof(observation)
  if (!verdict.ok) {
    throw new Error(
      `connect isolation proof failed [${verdict.code}]: ${verdict.message}`,
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

export interface ConnectIsolationScriptOptions {
  layout: ConnectIsolationLayout
  hostTools: IsolationHostTools
  /** The URL the denied web fetch targets; a local server that counts hits. */
  fetchUrl: string
  /** The name of the read tool's path argument on this host. Defaults to `filePath`. */
  readPathKey?: string
  /**
   * JavaScript the `execute` attempt runs. Defaults to a fetch of the denied
   * URL, which the web-fetch rule gates.
   */
  executeCode?: string
  /** How the parent dispatches the researcher on this host. */
  dispatch: { tool: string; arguments: Record<string, unknown> }
  /** Tells the researcher child's requests from the parent's on this host. */
  isChildRequest: (request: ChatRequest) => boolean
  requestCap?: number
}

export interface ConnectIsolationScript {
  respond(request: ChatRequest): ScriptedTurn
  observation(): Omit<
    ConnectIsolationObservation,
    'sideEffects' | 'parentAnswer'
  >
}

/** The proof's observation for a run: what the script saw plus what the disk and server show. */
export function connectObservation(
  script: ConnectIsolationScript,
  sideEffects: ConnectSideEffects,
  parentAnswer?: string,
): ConnectIsolationObservation {
  return {
    ...script.observation(),
    sideEffects,
    ...(parentAnswer !== undefined && { parentAnswer }),
  }
}

interface PlannedAttempt {
  readonly label: IsolationAttemptLabel
  readonly tool: string
  readonly arguments: Record<string, unknown>
}

function planAttempts(
  options: ConnectIsolationScriptOptions,
): PlannedAttempt[] {
  const { layout, hostTools, fetchUrl } = options
  return [
    {
      label: 'shell',
      tool: hostTools.shell,
      arguments: {
        command: `printf isolation-breach > "${layout.shellMarker}"`,
        description: 'Write the shell marker',
      },
    },
    {
      label: 'write',
      tool: hostTools.write,
      arguments: { filePath: layout.writeMarker, content: 'isolation-breach' },
    },
    {
      label: 'edit',
      tool: hostTools.edit,
      arguments: {
        filePath: layout.editTarget,
        oldString: EDIT_TARGET_ORIGINAL,
        newString: 'CHANGED-CONTENT',
      },
    },
    {
      label: 'webfetch',
      tool: hostTools.webfetch,
      arguments: { url: fetchUrl, format: 'text' },
    },
    ...(hostTools.execute === undefined
      ? []
      : [
          {
            label: 'execute' as const,
            tool: hostTools.execute,
            arguments: {
              code:
                options.executeCode ??
                `const response = await fetch(${JSON.stringify(fetchUrl)}); return await response.text()`,
            },
          },
        ]),
    ...(hostTools.websearch === undefined
      ? []
      : [
          {
            label: 'websearch' as const,
            tool: hostTools.websearch,
            arguments: { query: 'connect isolation probe' },
          },
        ]),
    {
      label: 'read',
      tool: hostTools.read,
      arguments: { [options.readPathKey ?? 'filePath']: layout.readTarget },
    },
  ]
}

function markerIn(text: string | undefined): string {
  return MARKER_PATTERN.exec(text ?? '')?.[0] ?? 'NO-MARKER'
}

/**
 * A small state machine over the scripted turns. A request that offers no tools
 * is the session title. Otherwise the host's own filter says whether the
 * request is the child's. The child makes one attempt per turn, chosen by how
 * many tool results its history already holds, and reports the marker the read
 * returned. The parent dispatches once and answers with the marker in the
 * result it was handed.
 */
export function createConnectIsolationScript(
  options: ConnectIsolationScriptOptions,
): ConnectIsolationScript {
  const requestCap = options.requestCap ?? CONNECT_REQUEST_CAP
  const planned = planAttempts(options)
  const childRequests: ChatRequest[] = []
  const parentRequests: ChatRequest[] = []
  let requestCount = 0
  let dispatched = false

  function childTurn(request: ChatRequest): ScriptedTurn {
    const results = toolResultsOf(request)
    const next = planned[results.length]
    if (next === undefined) {
      return { text: `${CONNECT_CHILD_FINAL} ${markerIn(results.at(-1))}` }
    }
    return {
      toolCalls: [
        {
          id: `connect-isolation-${next.label}`,
          name: next.tool,
          arguments: { ...next.arguments },
        },
      ],
    }
  }

  function parentTurn(request: ChatRequest): ScriptedTurn {
    if (lastMessageRole(request) === 'tool') {
      return {
        text: `${CONNECT_PARENT_FINAL} ${markerIn(toolResultsOf(request).at(-1))}`,
      }
    }
    if (dispatched) return { text: 'PARENT-UNEXPECTED-TURN' }
    dispatched = true
    return {
      toolCalls: [
        {
          id: 'connect-isolation-dispatch',
          name: options.dispatch.tool,
          arguments: { ...options.dispatch.arguments },
        },
      ],
    }
  }

  return {
    respond(request) {
      requestCount += 1
      if (requestCount > requestCap) return { text: 'REQUEST-CAP-EXCEEDED' }
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
      requestCap,
      childRequests: [...childRequests],
      parentRequests: [...parentRequests],
      attempts: planned.map((attempt) => attempt.label),
    }),
  }
}

// ── The researcher definition on a host ──────────────────────────────────────

/** The probe agent's name; the host dispatches it by this name. */
export const CONNECT_PROBE_AGENT = 'researcher-probe'

const PROBE_DEFINITION_FILE = path.resolve(
  import.meta.dirname,
  '../fixtures/connect-isolation/researcher-probe.md',
)

/** The probe agent definition as committed. */
export function readProbeDefinition(): string {
  return fs.readFileSync(PROBE_DEFINITION_FILE, 'utf8')
}

/** The definition under another agent name, for a run that must match a name-keyed guard. */
export function definitionNamed(definition: string, name: string): string {
  const renamed = definition.replace(/^name: .*$/m, `name: ${name}`)
  if (renamed === definition && !definition.includes(`name: ${name}`)) {
    throw new Error('definition has no name line to replace')
  }
  return renamed
}

/**
 * Installs a definition as a bundled agent of an extracted package, so the
 * host loads it through the same plugin path as a shipped agent.
 */
export function installProbeAgent(
  packageDir: string,
  definition: string,
  name: string = CONNECT_PROBE_AGENT,
): void {
  const target = path.join(packageDir, 'agents/research', `${name}.md`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, definition)
}

/**
 * The definition's first body line, cut to 80 characters. Every host puts the
 * agent body into the child's system prompt, and the parent's never holds it.
 */
export function probeSystemMarker(definition: string): string {
  const body = definition.replace(/^---\n[\s\S]*?\n---\n/, '')
  const line = body.split('\n').find((candidate) => candidate.trim() !== '')
  if (line === undefined) throw new Error('probe definition has no body')
  return line.slice(0, 80)
}

// ── The fetch target ─────────────────────────────────────────────────────────

export interface FetchCounter {
  /** The URL the denied web fetch targets. */
  readonly url: string
  hits(): number
  stop(): void
}

/** A local server that answers any request and counts how many it got. */
export function startFetchCounter(): FetchCounter {
  let hits = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      hits += 1
      return new Response('fetch target page', {
        headers: { 'Content-Type': 'text/plain' },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/probe`,
    hits: () => hits,
    stop: () => server.stop(true),
  }
}

// ── A plugin that watches the v2 tool hook ───────────────────────────────────

export interface ToolHookEvent {
  readonly tool: string
  readonly agent: string
  readonly sessionID: string
  readonly id: string
}

export interface ToolHookProbe {
  /** The directory a v2 host's `plugins` list names to load the probe. */
  readonly spec: string
  events(): ToolHookEvent[]
}

/**
 * Writes a small v2 plugin that records every `execute.before` event. With
 * `blockPrefixes` it also throws for any tool whose name starts with one of
 * them. Code Mode's nested calls arrive under the host-native tool names
 * (`opencode_*`), so blocking that prefix shows whether a throw reaches a
 * nested call and what the model sees.
 */
export function createToolHookProbe(
  rootDir: string,
  options: { blockPrefixes: readonly string[] },
): ToolHookProbe {
  const dir = path.join(rootDir, 'tool-hook-probe')
  const capturePath = path.join(rootDir, 'tool-hook-probe.jsonl')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'systematic-tool-hook-probe',
      type: 'module',
      exports: { '.': './index.js' },
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `import fs from 'node:fs'

const capturePath = ${JSON.stringify(capturePath)}
const blockPrefixes = ${JSON.stringify(options.blockPrefixes)}

export default {
  id: 'systematic-tool-hook-probe',
  async setup(ctx) {
    await ctx.tool.hook('execute.before', (event) => {
      fs.appendFileSync(
        capturePath,
        JSON.stringify({
          tool: event.tool,
          agent: event.agent,
          sessionID: event.sessionID,
          id: event.id,
        }) + '\\n',
      )
      if (blockPrefixes.some((prefix) => String(event.tool).startsWith(prefix))) {
        throw new Error('blocked by the tool hook probe: ' + event.tool)
      }
    })
  },
}
`,
  )
  return {
    spec: dir,
    events: () =>
      fs.existsSync(capturePath)
        ? fs
            .readFileSync(capturePath, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as ToolHookEvent)
        : [],
  }
}
