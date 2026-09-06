import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  type OpencodeAvailabilityClassification,
  probeOpencodeAvailability,
  resolveBunInstallCacheDir,
} from '../../../scripts/lib/opencode-availability.js'
import { readOpencodeSdkPin } from '../../../scripts/lib/opencode-pin.js'
import { stopProcessGroup } from '../../../scripts/lib/process-group.js'

export const TIMEOUT_MS = 180_000
// `string`, read from package.json at import time; throws if the pin is missing or not exact.
export const EXACT_OPENCODE_VERSION = readOpencodeSdkPin()
export const MAX_RETRIES = 1
export const RETRY_DELAY_MS = 3_000
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// `runOpencode`'s scripted provider: a local OpenAI-compatible server takes
// the place of the previously hosted free-tier model so the suite's only
// tool-invocation decision is deterministic and requires no network.
const SCRIPTED_PROVIDER_ID = 'systematic-host-contract-provider'
const SCRIPTED_MODEL_ID = 'systematic-host-contract-model'

export interface OpencodeResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface IsolatedFixture {
  tempRoot: string
  projectDir: string
  configDir: string
  homeDir: string
  xdgConfigHome: string
  xdgDataHome: string
  xdgCacheHome: string
  xdgStateHome: string
}

export function createIsolatedFixture(): IsolatedFixture {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'systematic-opencode-'),
  )
  const projectDir = path.join(tempRoot, 'project')
  const configDir = path.join(tempRoot, 'opencode-config')
  const homeDir = path.join(tempRoot, 'home')
  const xdgConfigHome = path.join(tempRoot, 'xdg-config')
  const xdgDataHome = path.join(tempRoot, 'xdg-data')
  const xdgCacheHome = path.join(tempRoot, 'xdg-cache')
  const xdgStateHome = path.join(tempRoot, 'xdg-state')

  for (const dir of [
    projectDir,
    configDir,
    homeDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'systematic-integration-fixture',
      private: true,
      type: 'module',
    }),
  )

  return {
    tempRoot,
    projectDir,
    configDir,
    homeDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
  }
}

export function destroyIsolatedFixture(fixture: IsolatedFixture): void {
  fs.rmSync(fixture.tempRoot, { recursive: true, force: true })
}

const REDACT_PATTERNS = [/TOKEN/i, /KEY/i, /SECRET/i, /PAT/i, /AUTH/i]

const ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'NODE_PATH',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'COHERE_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'PERPLEXITY_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENCODE_API_KEY',
])

function redactSensitive(text: string): string {
  let result = text
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue
    if (REDACT_PATTERNS.some((pattern) => pattern.test(key))) {
      result = result.replaceAll(value, '[REDACTED]')
    }
  }
  return result
}

export function buildChildEnv(
  overrides: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) base[key] = value
  }
  return {
    ...base,
    BUN_INSTALL_CACHE_DIR: resolveBunInstallCacheDir({
      pin: EXACT_OPENCODE_VERSION,
    }),
    ...overrides,
  }
}

// Computed lazily and memoized only by `getOpencodeAvailability()` below, never
// eagerly at module scope: this module must do no probing and no throwing at
// import time, so `tests/unit/*` importers (and the required `test` job) never
// spawn `bunx`. Each integration test module that gates on the host calls
// `getOpencodeAvailability()` / `isOpencodeAvailable()` at its own module
// scope and passes the result to `requireOpencodeAvailable()` itself.
let cachedOpencodeAvailability: OpencodeAvailabilityClassification | undefined

function computeOpencodeAvailability(): OpencodeAvailabilityClassification {
  const probeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'systematic-opencode-probe-'),
  )
  try {
    // Fixtures redirect HOME/XDG paths, so the probe must also run in that
    // environment. The OPENCODE_DISABLE_* flags mirror buildIsolatedOpencodeEnv
    // below (the real hosts' env) so a first-run autoupdate/models fetch can't
    // pollute the probe's stdout or add network latency the real hosts don't pay.
    return probeOpencodeAvailability({
      pin: EXACT_OPENCODE_VERSION,
      env: buildChildEnv({
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_PRUNE: '1',
        HOME: probeRoot,
        XDG_CONFIG_HOME: probeRoot,
        XDG_DATA_HOME: probeRoot,
        XDG_CACHE_HOME: probeRoot,
        XDG_STATE_HOME: probeRoot,
      }),
    })
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true })
  }
}

export function getOpencodeAvailability(): OpencodeAvailabilityClassification {
  cachedOpencodeAvailability ??= computeOpencodeAvailability()
  return cachedOpencodeAvailability
}

export function isOpencodeAvailable(): boolean {
  return getOpencodeAvailability().status === 'available'
}

export function opencodeAvailabilityReason(): string {
  return getOpencodeAvailability().reason
}

export function buildIsolatedOpencodeEnv(
  fixture: IsolatedFixture,
  configContent: string,
  overrides?: Record<string, string>,
): Record<string, string> {
  return buildChildEnv({
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_PRUNE: '1',
    ...overrides,
    HOME: fixture.homeDir,
    XDG_CONFIG_HOME: fixture.xdgConfigHome,
    XDG_DATA_HOME: fixture.xdgDataHome,
    XDG_CACHE_HOME: fixture.xdgCacheHome,
    XDG_STATE_HOME: fixture.xdgStateHome,
    OPENCODE_CONFIG_DIR: fixture.configDir,
    OPENCODE_CONFIG_CONTENT: configContent,
  })
}

export interface ScriptedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ScriptedResponse {
  text?: string
  toolCalls?: ScriptedToolCall[]
}

export interface ScriptedModelServer {
  url: string
  stop(): void
}

function sseChunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

export function scriptedResponseChunks(
  response: ScriptedResponse,
  requestId: string,
  created: number,
): Record<string, unknown>[] {
  if (response.toolCalls && response.toolCalls.length > 0) {
    return [
      ...response.toolCalls.map((toolCall, index) => ({
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: SCRIPTED_MODEL_ID,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: toolCall.id,
                  type: 'function',
                  function: {
                    name: toolCall.name,
                    arguments: JSON.stringify(toolCall.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })),
      {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: SCRIPTED_MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ]
  }
  const text = response.text ?? ''
  return [
    {
      id: requestId,
      object: 'chat.completion.chunk',
      created,
      model: SCRIPTED_MODEL_ID,
      choices: [
        {
          index: 0,
          delta: text ? { role: 'assistant' } : {},
          finish_reason: null,
        },
      ],
    },
    ...(text
      ? [
          {
            id: requestId,
            object: 'chat.completion.chunk',
            created,
            model: SCRIPTED_MODEL_ID,
            choices: [
              { index: 0, delta: { content: text }, finish_reason: null },
            ],
          },
        ]
      : []),
    {
      id: requestId,
      object: 'chat.completion.chunk',
      created,
      model: SCRIPTED_MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ]
}

interface ChatCompletionRequestBody {
  tools?: unknown
  messages?: unknown
}

function isChatCompletionRequestBody(
  value: unknown,
): value is ChatCompletionRequestBody {
  return isRecord(value)
}

function requestCarriesToolResult(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  return messages.some(
    (message) => isRecord(message) && message.role === 'tool',
  )
}

/**
 * Starts a local OpenAI-compatible scripted model server for one
 * `runOpencode` invocation. OpenCode's `run` CLI issues two kinds of
 * requests against the configured model: the real chat turn (always carries
 * a non-empty `tools` array) and, once per session, a background title-
 * generation turn forked from `SessionPrompt.ensureTitle` with `tools: {}`
 * (opencode's `session/prompt.ts`). That title turn is forked concurrently
 * with the main loop, so its arrival relative to the main call is not
 * ordered; dispatch is therefore based on the request body shape (tool
 * presence, then tool-result presence), never on call order.
 *
 * The scripted `systematic_skill` tool call is issued at most once per
 * server instance: once issued, every later tool-capable request (whether
 * or not it actually carries the tool result — a mis-registration means it
 * never will) falls through to `completionText` instead of re-issuing the
 * call. A broken registration then fails fast on the real assertions
 * (the host's own tool-invocation log, the probe capture) instead of
 * silently re-prompting until the step cap.
 */
export function startScriptedSkillModelServer(
  skillName: string,
  completionText: string,
): ScriptedModelServer {
  let toolCallIssued = false
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        !request.url.endsWith('/chat/completions')
      ) {
        return new Response('not found', { status: 404 })
      }
      const rawBody: unknown = await request.json()
      const body = isChatCompletionRequestBody(rawBody) ? rawBody : {}
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0

      let response: ScriptedResponse
      if (!hasTools) {
        response = { text: 'Systematic host contract title probe' }
      } else if (toolCallIssued || requestCarriesToolResult(body.messages)) {
        response = { text: completionText }
      } else {
        toolCallIssued = true
        response = {
          toolCalls: [
            {
              id: 'host-contract-skill-call',
              name: 'systematic_skill',
              arguments: { name: skillName },
            },
          ],
        }
      }

      const chunks = scriptedResponseChunks(
        response,
        'host-contract-response',
        Math.floor(Date.now() / 1000),
      )
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          for (const chunk of chunks)
            controller.enqueue(encoder.encode(sseChunk(chunk)))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

const LOAD_SKILL_PROMPT_PATTERN =
  /^Use the systematic_skill tool to load (\S+)$/

/**
 * Every `runOpencode` call site prompts with the fixed shape "Use the
 * systematic_skill tool to load <name>"; extracting the name here lets the
 * scripted model script the exact tool call each call site's assertions
 * expect, without each call site building its own model script.
 */
export function extractSkillNameFromPrompt(prompt: string): string {
  const match = LOAD_SKILL_PROMPT_PATTERN.exec(prompt)
  const skillName = match?.[1]
  if (!skillName) {
    throw new Error(
      `runOpencode's scripted provider could not extract a skill name from prompt: ${prompt}`,
    )
  }
  return skillName
}

export function withScriptedProvider(
  configContent: string,
  baseUrl: string,
): string {
  const parsed = JSON.parse(configContent) as Record<string, unknown>
  const existingProvider =
    typeof parsed.provider === 'object' && parsed.provider !== null
      ? (parsed.provider as Record<string, unknown>)
      : {}
  return JSON.stringify({
    ...parsed,
    provider: {
      ...existingProvider,
      [SCRIPTED_PROVIDER_ID]: {
        name: 'Systematic Host Contract Provider',
        id: SCRIPTED_PROVIDER_ID,
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [SCRIPTED_MODEL_ID]: {
            id: SCRIPTED_MODEL_ID,
            name: 'Systematic Host Contract Model',
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: '2026-09-04',
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: 'unused-host-contract-key', baseURL: baseUrl },
      },
    },
  })
}

export interface RunOpencodeOptions {
  fixture: IsolatedFixture
  configContent: string
  extraEnv?: Record<string, string>
}

/**
 * Runs an argv async via node's `spawn`, never `Bun.spawnSync`. This function
 * (and every other real `opencode` child process in this module) shares the
 * event loop with `startScriptedSkillModelServer`'s `Bun.serve` instance: a
 * synchronous spawn would block that same thread for its whole duration, so
 * the scripted server could never answer the child's own HTTP request back
 * to it — every scripted call would hang to its timeout. An async spawn is
 * non-blocking, so the server keeps servicing requests while this awaits.
 *
 * The real argv is `bunx opencode-ai@<pin> run ...`: `bunx` execs or forks
 * `opencode-ai` as a descendant, so a plain `child.kill()` on timeout would
 * signal only the direct `bunx` process and leave that `opencode-ai`
 * grandchild alive, holding the stdout/stderr pipe write-ends open — this
 * function's stream reads would then never see EOF and it would hang past
 * its own timeout, leaking the grandchild besides. So the child is spawned
 * `detached: true` (a new process group) and, on timeout, the *whole group*
 * is reaped via `stopProcessGroup` (SIGTERM then SIGKILL to the group),
 * exactly like the sibling `startOpencodeProcess`/`stopOpencodeProcess`
 * below. Killing the group closes every descendant's pipes, so this
 * function's stream listeners finish and the promise resolves instead of
 * hanging.
 */
export async function spawnOpencodeChild(
  argv: readonly string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<OpencodeResult> {
  const [command, ...rest] = argv
  if (!command) throw new Error('spawnOpencodeChild requires a non-empty argv')

  return new Promise<OpencodeResult>((resolve) => {
    const child = spawn(command, rest, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ stdout, stderr, exitCode })
    }

    const timeout = setTimeout(() => {
      void stopProcessGroup(child, 10_000).then(() => finish(-1))
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => {
      stderr += `\n${String(error)}`
      finish(-1)
    })
    child.once('close', (code) => {
      finish(code ?? -1)
    })
  })
}

export async function runOpencode(
  prompt: string,
  options: RunOpencodeOptions,
): Promise<OpencodeResult> {
  const { fixture, configContent, extraEnv } = options
  const skillName = extractSkillNameFromPrompt(prompt)
  const model = startScriptedSkillModelServer(
    skillName,
    `Loaded skill ${skillName}. Reviewing repository state now.`,
  )

  try {
    const scriptedConfigContent = withScriptedProvider(configContent, model.url)
    const childEnv = buildIsolatedOpencodeEnv(
      fixture,
      scriptedConfigContent,
      extraEnv,
    )
    let lastResult: OpencodeResult = { stdout: '', stderr: '', exitCode: -1 }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      lastResult = await spawnOpencodeChild(
        [
          'bunx',
          `opencode-ai@${EXACT_OPENCODE_VERSION}`,
          'run',
          '--model',
          `${SCRIPTED_PROVIDER_ID}/${SCRIPTED_MODEL_ID}`,
          prompt,
        ],
        { cwd: fixture.projectDir, env: childEnv, timeoutMs: TIMEOUT_MS },
      )

      const isTimeout =
        lastResult.exitCode === -1 || lastResult.stderr.includes('ETIMEDOUT')
      const isRateLimit =
        lastResult.stderr.includes('rate limit') ||
        lastResult.stderr.includes('429')

      if (!isTimeout && !isRateLimit && lastResult.exitCode === 0) {
        return lastResult
      }

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt
        console.log(
          `Attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms...`,
        )
        await Bun.sleep(delay)
      }
    }

    return lastResult
  } finally {
    model.stop()
  }
}

export function assertOk(result: OpencodeResult): void {
  if (result.exitCode === 0) return
  const stdoutTail = redactSensitive(result.stdout.slice(-2000))
  const stderrTail = redactSensitive(result.stderr.slice(-2000))
  throw new Error(
    `opencode exited with code ${result.exitCode}\n` +
      `--- stdout (tail) ---\n${stdoutTail}\n` +
      `--- stderr (tail) ---\n${stderrTail}`,
  )
}

export type ProbeTransformKind = 'chat' | 'title' | 'unknown'

export interface ProbeLoadedEvent {
  type: 'loaded'
}

export interface ProbeSystemEvent {
  type: 'system'
  kind: ProbeTransformKind
  input: Record<string, unknown>
  system: string[]
}

export interface ProbeToolEvent {
  type: 'tool'
  description: string
  parameters: unknown
}

export type ProbeEvent = ProbeLoadedEvent | ProbeSystemEvent | ProbeToolEvent

const PROBE_SYSTEM_KINDS = new Set<ProbeTransformKind>([
  'chat',
  'title',
  'unknown',
])

export function isProbeSystemEvent(
  value: ProbeEvent,
): value is ProbeSystemEvent {
  return value.type === 'system'
}

export function isProbeToolEvent(value: ProbeEvent): value is ProbeToolEvent {
  return value.type === 'tool'
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  )
}

function isProbeEvent(value: unknown): value is ProbeEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false

  if (value.type === 'loaded') return Object.keys(value).length === 1

  if (value.type === 'system') {
    return (
      typeof value.kind === 'string' &&
      PROBE_SYSTEM_KINDS.has(value.kind as ProbeTransformKind) &&
      isRecord(value.input) &&
      isStringArray(value.system)
    )
  }

  if (value.type === 'tool') {
    return typeof value.description === 'string' && 'parameters' in value
  }

  return false
}

export function parseProbeEvent(line: string, index: number): ProbeEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch (error) {
    throw new Error(`invalid JSONL capture line ${index + 1}: ${String(error)}`)
  }

  if (!isProbeEvent(parsed)) {
    throw new Error(`malformed probe event at line ${index + 1}: ${line}`)
  }

  return parsed
}

export function countWorkflowBlocks(system: readonly string[]): number {
  return system.reduce(
    (count, entry) => count + entry.split('<SYSTEMATIC_WORKFLOWS>').length - 1,
    0,
  )
}

function countMarkerOccurrences(
  system: readonly string[],
  marker: string,
): number {
  return system.reduce(
    (count, entry) => count + entry.split(marker).length - 1,
    0,
  )
}

export function createProbePlugin(fixture: IsolatedFixture): {
  url: string
  capturePath: string
} {
  const probeDir = path.join(fixture.tempRoot, 'probe-plugin')
  const probePath = path.join(probeDir, 'index.mjs')
  const capturePath = path.join(fixture.tempRoot, 'probe-capture.jsonl')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.writeFileSync(
    path.join(probeDir, 'package.json'),
    JSON.stringify({
      name: 'systematic-integration-probe',
      type: 'module',
      main: './index.mjs',
    }),
  )
  fs.writeFileSync(
    probePath,
    `import fs from 'node:fs'

const capturePath = ${JSON.stringify(capturePath)}

function append(entry) {
  fs.appendFileSync(capturePath, JSON.stringify(entry) + '\\n')
}

function classifyTransformInput(input) {
  if (!input || typeof input !== 'object') return 'unknown'
  if (typeof input.sessionID === 'string' && 'model' in input) return 'chat'
  if ('model' in input && !('sessionID' in input)) return 'title'
  return 'unknown'
}

export default async function probe() {
  append({ type: 'loaded' })
  return {
    'tool.definition': async (input, output) => {
      if (input.toolID !== 'systematic_skill') return
      append({
        type: 'tool',
        description: output.description,
        parameters: output.parameters,
      })
    },
    'experimental.chat.system.transform': async (input, output) => {
      append({ type: 'system', kind: classifyTransformInput(input), input, system: output.system })
    },
  }
}
`,
  )

  return { url: pathToFileURL(probeDir).href, capturePath }
}

export function readProbeEvents(capturePath: string): ProbeEvent[] {
  if (!fs.existsSync(capturePath)) return []
  const content = fs.readFileSync(capturePath, 'utf8').trim()
  if (content === '') return []
  return content
    .split('\n')
    .map((line: string, index: number) => parseProbeEvent(line, index))
}

export function assertProbeCapturedEvents(probe: {
  capturePath: string
}): ProbeEvent[] {
  const events = readProbeEvents(probe.capturePath)
  if (events.length > 0) return events

  throw new Error(
    `probe plugin did not capture any events at ${probe.capturePath}`,
  )
}

function assertWorkflowSystem(system: readonly string[]): void {
  const openingMarkerCount = countMarkerOccurrences(
    system,
    '<SYSTEMATIC_WORKFLOWS>',
  )
  const closingMarkerCount = countMarkerOccurrences(
    system,
    '</SYSTEMATIC_WORKFLOWS>',
  )
  if (openingMarkerCount !== 1 || closingMarkerCount !== 1) {
    throw new Error(
      'workflow system must contain exactly one opening and one closing marker',
    )
  }
  if (!system[0]?.includes('<SYSTEMATIC_WORKFLOWS>')) {
    throw new Error('workflow block was not first system entry')
  }
  for (const [index, entry] of system.entries()) {
    if (index > 0 && entry.includes('<SYSTEMATIC_WORKFLOWS>')) {
      throw new Error('workflow block appeared in a later system entry')
    }
  }
  const firstSystem = system[0]
  if (!firstSystem?.includes('</SYSTEMATIC_WORKFLOWS>')) {
    throw new Error('workflow system block was not closed')
  }
  if (
    firstSystem.indexOf('</SYSTEMATIC_WORKFLOWS>') <
    firstSystem.indexOf('<SYSTEMATIC_WORKFLOWS>')
  ) {
    throw new Error('workflow system block markers were out of order')
  }
  if (
    !firstSystem.includes(
      'Use `systematic_skill` to load Systematic bundled skills',
    )
  ) {
    throw new Error(
      'workflow system omitted systematic_skill discovery guidance',
    )
  }
}

export function assertMixedVersionProbeEvents(events: ProbeEvent[]): void {
  const systemEvents = events.filter(isProbeSystemEvent)
  const chatSystemEvents = systemEvents.filter((event) => event.kind === 'chat')
  const workflowSystems = chatSystemEvents
    .map((event) => event.system)
    .filter((system) => countWorkflowBlocks(system) > 0)
  if (chatSystemEvents.length === 0) {
    throw new Error(
      'mixed-version probe did not observe a chat transform event',
    )
  }
  if (workflowSystems.length === 0) {
    throw new Error(
      'mixed-version probe did not observe a workflow system block',
    )
  }
  for (const system of workflowSystems) assertWorkflowSystem(system)

  for (const event of systemEvents.filter((entry) => entry.kind === 'title')) {
    if (countWorkflowBlocks(event.system) !== 0) {
      throw new Error('title transform unexpectedly received workflow block')
    }
  }
}

async function startOpencodeProcess(
  fixture: IsolatedFixture,
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs = TIMEOUT_MS,
): Promise<OpencodeServer> {
  const server = spawn(command, [...args], {
    env,
    cwd: fixture.projectDir,
    detached: true,
  })
  const pid = server.pid
  if (!pid) throw new Error('opencode server did not expose a process id')

  const url = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    const timeout = setTimeout(() => {
      void stopOpencodeProcess(server).then(() => {
        reject(
          new Error(`OpenCode server start timed out: ${buffer.slice(-500)}`),
        )
      })
    }, timeoutMs)

    const onChunk = (chunk: Buffer): void => {
      buffer += chunk.toString()
      const match = buffer.match(/(http:\/\/[\d.:]+)/)
      if (!match) return
      clearTimeout(timeout)
      resolve(match[1])
    }

    server.stdout?.on('data', onChunk)
    server.stderr?.on('data', onChunk)
    server.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    server.once('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout)
        reject(new Error(`OpenCode server exited early with code ${code}`))
      }
    })
  })

  let stopped = false
  const host: OpencodeServer = {
    url,
    pid,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      try {
        await stopOpencodeProcess(server)
      } finally {
        liveOpencodeHosts.delete(host)
      }
    },
  }
  liveOpencodeHosts.add(host)
  server.once('exit', () => {
    // A pgid cannot be recycled while its group has members, so this is a safe
    // ownership probe. Only evict once the group is actually empty; otherwise
    // the launcher exited but the opencode grandchild is still alive and
    // needs to stay reachable for stopAllOpencodeHosts/the terminal-signal guard.
    try {
      process.kill(-pid, 0)
    } catch {
      liveOpencodeHosts.delete(host)
    }
  })
  installTerminalSignalHandlers()
  return host
}

export async function startOpencodeServer(
  fixture: IsolatedFixture,
  configContent: string,
  extraEnv?: Record<string, string>,
): Promise<OpencodeServer> {
  return startOpencodeProcess(
    fixture,
    'bunx',
    [
      `opencode-ai@${EXACT_OPENCODE_VERSION}`,
      'serve',
      '--port',
      '0',
      '--print-logs',
    ],
    buildIsolatedOpencodeEnv(fixture, configContent, extraEnv),
  )
}

export async function startExactOpencodeServer(
  fixture: IsolatedFixture,
  configContent: string,
  version: string,
  extraEnv?: Record<string, string>,
  timeoutMs = TIMEOUT_MS,
): Promise<OpencodeServer> {
  return startOpencodeProcess(
    fixture,
    'bunx',
    [`opencode-ai@${version}`, 'serve', '--port', '0', '--print-logs'],
    buildIsolatedOpencodeEnv(fixture, configContent, extraEnv),
    timeoutMs,
  )
}

export interface OpencodeServer {
  url: string
  pid: number
  stop(): Promise<void>
}

const liveOpencodeHosts = new Set<OpencodeServer>()

let terminalSignalHandlersInstalled = false

function killLiveOpencodeHostsSync(): void {
  for (const host of liveOpencodeHosts) {
    try {
      process.kill(-host.pid, 'SIGKILL')
    } catch {
      // Cleanup is best effort; the process may already be gone.
    }
  }
}

function installTerminalSignalHandlers(): void {
  if (terminalSignalHandlersInstalled) return
  terminalSignalHandlersInstalled = true

  process.on('SIGINT', () => {
    killLiveOpencodeHostsSync()
    // Exiting here skips remaining afterAll hooks (temp dirs may leak); orphaned host processes cost more than temp dirs.
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    killLiveOpencodeHostsSync()
    // Exiting here skips remaining afterAll hooks (temp dirs may leak); orphaned host processes cost more than temp dirs.
    process.exit(143)
  })
  process.on('exit', killLiveOpencodeHostsSync)
}

async function stopOpencodeProcess(server: ChildProcess): Promise<void> {
  await stopProcessGroup(server, 10_000)
}

export async function stopAllOpencodeHosts(): Promise<void> {
  await Promise.all([...liveOpencodeHosts].map((host) => host.stop()))
}

let packedTarballPath: string | null = null
let packTempDir: string | null = null

export function packTarballOnce(): void {
  if (packedTarballPath) return
  const build = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: REPO_ROOT,
    timeout: 120_000,
  })
  if (build.exitCode !== 0) {
    throw new Error(
      `bun run build failed (exit ${build.exitCode})\n--- stdout ---\n${build.stdout.toString()}\n--- stderr ---\n${build.stderr.toString()}`,
    )
  }

  packTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-pack-'))
  const pack = Bun.spawnSync(
    ['npm', 'pack', '--pack-destination', packTempDir, '--silent'],
    { cwd: REPO_ROOT, timeout: 60_000 },
  )
  if (pack.exitCode !== 0) {
    throw new Error(
      `npm pack failed (exit ${pack.exitCode})\n--- stdout ---\n${pack.stdout.toString()}\n--- stderr ---\n${pack.stderr.toString()}`,
    )
  }
  const tarballName = pack.stdout.toString().trim().split('\n').at(-1)
  if (!tarballName) throw new Error('npm pack produced no tarball filename')
  packedTarballPath = path.join(packTempDir, tarballName)
}

export function cleanupPackedTarball(): void {
  if (packTempDir) fs.rmSync(packTempDir, { recursive: true, force: true })
  packedTarballPath = null
  packTempDir = null
}

function linkRuntimeDependency(
  fixture: IsolatedFixture,
  packageName: string,
): void {
  const source = path.join(REPO_ROOT, 'node_modules', packageName)
  const target = path.join(fixture.projectDir, 'node_modules', packageName)
  if (!fs.existsSync(source)) {
    throw new Error(
      `runtime dependency "${packageName}" declared by the packaged plugin is missing from ${source}`,
    )
  }
  if (fs.existsSync(target)) return
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.symlinkSync(source, target, 'dir')
}

export function extractPackagedPlugin(fixture: IsolatedFixture): {
  packageDir: string
  pluginUrl: string
} {
  if (!packedTarballPath) throw new Error('packTarballOnce() has not run')

  const scopeDir = path.join(fixture.projectDir, 'node_modules/@fro.bot')
  const packageDir = path.join(scopeDir, 'systematic')
  fs.mkdirSync(scopeDir, { recursive: true })

  const extract = Bun.spawnSync(
    ['tar', 'xzf', packedTarballPath, '-C', scopeDir],
    { timeout: 30_000 },
  )
  if (extract.exitCode !== 0) {
    throw new Error(
      `tar extraction failed (exit ${extract.exitCode}): ${extract.stderr.toString()}`,
    )
  }
  fs.renameSync(path.join(scopeDir, 'package'), packageDir)

  const extractedPackageJson = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> }
  for (const depName of Object.keys(extractedPackageJson.dependencies ?? {})) {
    linkRuntimeDependency(fixture, depName)
  }
  linkRuntimeDependency(fixture, '@opencode-ai/plugin')

  return { packageDir, pluginUrl: pathToFileURL(packageDir).href }
}
