import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  type OpencodeAvailabilityClassification,
  opencodeBinaryEnvName,
  probeOpencodeAvailability,
  resolveBunInstallCacheDir,
  resolveOpencodeBinary,
  resolveOpencodeHost,
  resolveTargetOpencodePin,
} from '../../../scripts/lib/opencode-availability.js'
import {
  OPENCODE_CLI_PACKAGES,
  type OpencodeHost,
} from '../../../scripts/lib/opencode-pin.js'
import { stopProcessGroup } from '../../../scripts/lib/process-group.js'

export type { OpencodeHost }

export const TIMEOUT_MS = 180_000
// The host line this run targets: `SYSTEMATIC_OPENCODE_HOST`, `v1` when unset.
// Every host-taking function below defaults to it, so a suite written for one
// host runs unchanged until a caller passes a host explicitly.
export const TARGET_OPENCODE_HOST: OpencodeHost = resolveOpencodeHost()
// `string`, read from the pin file at import time; throws if the pin is missing or not exact.
// A v1 run targets the current v1 pin, or the v1 floor when `SYSTEMATIC_OPENCODE_V1_LINE=floor`.
export const EXACT_OPENCODE_VERSION =
  resolveTargetOpencodePin(TARGET_OPENCODE_HOST)
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
// The env var a v2 scripted provider reads its key from. The key is a dummy:
// the scripted server ignores it.
const SCRIPTED_PROVIDER_KEY_ENV = 'SYSTEMATIC_HOST_CONTRACT_KEY'
// A v2 host's OpenAI-compatible provider package.
const V2_OPENAI_COMPATIBLE_PACKAGE = '@opencode/ai/providers/openai-compatible'

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
  /** Per-fixture TMPDIR; a v2 host keeps its scratch space under it. */
  tmpDir: string
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
  const tmpDir = path.join(tempRoot, 'tmp')

  for (const dir of [
    projectDir,
    configDir,
    homeDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
    tmpDir,
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
    tmpDir,
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

/**
 * The allowlisted parent env plus `overrides`. Only a v1 host is launched
 * through `bunx`, so only a v1 child gets the shared `BUN_INSTALL_CACHE_DIR`
 * for its pin; a v2 child runs an installed binary and never touches it.
 */
export function buildChildEnv(
  overrides: Record<string, string>,
  host: OpencodeHost = TARGET_OPENCODE_HOST,
): Record<string, string> {
  const base: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) base[key] = value
  }
  const bunCache: Record<string, string> =
    host === 'v1'
      ? {
          BUN_INSTALL_CACHE_DIR: resolveBunInstallCacheDir({
            pin: resolveTargetOpencodePin('v1'),
          }),
        }
      : {}
  return { ...base, ...bunCache, ...overrides }
}

// Computed lazily and memoized per host only by `getOpencodeAvailability()`
// below, never eagerly at module scope: this module must do no probing and no
// throwing at import time, so `tests/unit/*` importers (and the required `test`
// job) never spawn `bunx`. Each integration test module that gates on the host
// calls `getOpencodeAvailability()` / `isOpencodeAvailable()` at its own module
// scope and passes the result to `requireOpencodeAvailable()` itself.
export interface HostAvailabilityCache {
  get(host: OpencodeHost): OpencodeAvailabilityClassification
}

/**
 * One memo slot per host, so asking for v2 after v1 (or the reverse) returns
 * each host's own classification and never the other's. `compute` runs at most
 * once per host.
 */
export function createHostAvailabilityCache(
  compute: (host: OpencodeHost) => OpencodeAvailabilityClassification,
): HostAvailabilityCache {
  const cached = new Map<OpencodeHost, OpencodeAvailabilityClassification>()
  return {
    get(host) {
      const existing = cached.get(host)
      if (existing !== undefined) return existing
      const classification = compute(host)
      cached.set(host, classification)
      return classification
    },
  }
}

const AUTOUPDATE_AND_FETCH_FLAGS = {
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_PRUNE: '1',
} as const

function computeOpencodeAvailability(
  host: OpencodeHost,
): OpencodeAvailabilityClassification {
  const probeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'systematic-opencode-probe-'),
  )
  try {
    // Fixtures redirect HOME/XDG paths, so the probe must also run in that
    // environment. The OPENCODE_DISABLE_* flags mirror buildIsolatedOpencodeEnv
    // below (the real hosts' env) so a first-run autoupdate/models fetch can't
    // pollute the probe's stdout or add network latency the real hosts don't pay.
    // A v2 host also keeps its scratch space under TMPDIR, which the probe
    // redirects too.
    return probeOpencodeAvailability({
      pin: resolveTargetOpencodePin(host),
      host,
      binary: resolveOpencodeBinary(host),
      env: buildChildEnv(
        {
          ...AUTOUPDATE_AND_FETCH_FLAGS,
          HOME: probeRoot,
          XDG_CONFIG_HOME: probeRoot,
          XDG_DATA_HOME: probeRoot,
          XDG_CACHE_HOME: probeRoot,
          XDG_STATE_HOME: probeRoot,
          ...(host === 'v2' ? { TMPDIR: probeRoot } : {}),
        },
        host,
      ),
    })
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true })
  }
}

const availabilityCache = createHostAvailabilityCache(
  computeOpencodeAvailability,
)

export function getOpencodeAvailability(
  host: OpencodeHost = TARGET_OPENCODE_HOST,
): OpencodeAvailabilityClassification {
  return availabilityCache.get(host)
}

export function isOpencodeAvailable(
  host: OpencodeHost = TARGET_OPENCODE_HOST,
): boolean {
  return getOpencodeAvailability(host).status === 'available'
}

export function opencodeAvailabilityReason(
  host: OpencodeHost = TARGET_OPENCODE_HOST,
): string {
  return getOpencodeAvailability(host).reason
}

/**
 * The environment a fixture's host child runs under: HOME, the four XDG roots
 * and the config dir all inside the fixture. A v1 host takes its config as
 * `OPENCODE_CONFIG_CONTENT`. A v2 host reads the project's `opencode.json`
 * (see {@link writeHostProjectConfig}), keeps its scratch space under TMPDIR,
 * and needs the scripted provider's key variable.
 */
export function buildIsolatedOpencodeEnv(
  fixture: IsolatedFixture,
  configContent: string,
  overrides?: Record<string, string>,
  host: OpencodeHost = TARGET_OPENCODE_HOST,
): Record<string, string> {
  const hostSpecific: Record<string, string> =
    host === 'v2'
      ? {
          TMPDIR: fixture.tmpDir,
          [SCRIPTED_PROVIDER_KEY_ENV]: 'unused-host-contract-key',
        }
      : { OPENCODE_CONFIG_CONTENT: configContent }
  return buildChildEnv(
    {
      ...AUTOUPDATE_AND_FETCH_FLAGS,
      ...overrides,
      HOME: fixture.homeDir,
      XDG_CONFIG_HOME: fixture.xdgConfigHome,
      XDG_DATA_HOME: fixture.xdgDataHome,
      XDG_CACHE_HOME: fixture.xdgCacheHome,
      XDG_STATE_HOME: fixture.xdgStateHome,
      OPENCODE_CONFIG_DIR: fixture.configDir,
      ...hostSpecific,
    },
    host,
  )
}

/**
 * Writes the config a v2 host reads from the project directory, and returns
 * the path. A v1 host takes its config through the environment instead, so
 * this is a no-op for v1 and returns `undefined`.
 */
export function writeHostProjectConfig(
  fixture: IsolatedFixture,
  configContent: string,
  host: OpencodeHost = TARGET_OPENCODE_HOST,
): string | undefined {
  if (host !== 'v2') return undefined
  const configPath = path.join(fixture.projectDir, 'opencode.json')
  fs.writeFileSync(configPath, configContent)
  return configPath
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

/**
 * Adds the scripted provider to a host-neutral config. A v1 host takes a
 * `provider` map and the plugin list under `plugin`. A v2 host takes
 * `providers`, a provider `package`, a top-level `model`, and the plugin list
 * under `plugins`, so a `plugin` list in the input is moved to `plugins`.
 */
export function withScriptedProvider(
  configContent: string,
  baseUrl: string,
  host: OpencodeHost = 'v1',
): string {
  const parsed = JSON.parse(configContent) as Record<string, unknown>
  if (host === 'v2') return withScriptedProviderV2(parsed, baseUrl)
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

function withScriptedProviderV2(
  parsed: Record<string, unknown>,
  baseUrl: string,
): string {
  const { plugin, providers, ...rest } = parsed
  const existingProviders = isRecord(providers) ? providers : {}
  const pluginList = rest.plugins ?? plugin
  return JSON.stringify({
    ...rest,
    ...(pluginList === undefined ? {} : { plugins: pluginList }),
    providers: {
      ...existingProviders,
      [SCRIPTED_PROVIDER_ID]: {
        name: 'Systematic Host Contract Provider',
        package: V2_OPENAI_COMPATIBLE_PACKAGE,
        env: [SCRIPTED_PROVIDER_KEY_ENV],
        settings: { baseURL: baseUrl },
        models: {
          [SCRIPTED_MODEL_ID]: { name: 'Systematic Host Contract Model' },
        },
      },
    },
    model: `${SCRIPTED_PROVIDER_ID}/${SCRIPTED_MODEL_ID}`,
  })
}

export interface RunOpencodeOptions {
  fixture: IsolatedFixture
  configContent: string
  extraEnv?: Record<string, string>
  /** Defaults to the run's target host. */
  host?: OpencodeHost
}

/**
 * Shared `spawn` options for every real `opencode`-launching child process in
 * this module (`spawnOpencodeChild`, `startOpencodeProcess`): `detached: true`
 * (its own process group, so the whole group can be reaped by pgid) and
 * `stdio: ['ignore', 'pipe', 'pipe']` (stdin closed from the start, so
 * `opencode run`'s stdin handling can't block on a pipe this fixture never
 * writes to or closes -- see spawnOpencodeChild's doc comment below for the
 * empirical evidence). Both call sites build their options through this one
 * function so they cannot quietly diverge on either point.
 */
export function buildDetachedChildSpawnOptions(
  cwd: string,
  env: Record<string, string>,
): SpawnOptions {
  return { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
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
 *
 * stdin is explicitly `'ignore'`, never the node default open pipe. Against
 * a real `opencode-ai` host (confirmed empirically: identical argv/env hangs
 * to the full timeout with a default `spawn` and returns in seconds once
 * stdin is ignored), `opencode run`'s stdin handling blocks on that pipe
 * never reaching EOF — the parent here has no writer for it and never
 * closes it, so the child waits forever for input it will never receive.
 * Ignoring stdin closes it from the start, matching how a real terminal
 * invocation's stdin behaves for a one-shot `run` command with the prompt
 * passed as an argument.
 *
 * The child's pid is registered in `liveRunOpencodeChildPids` for the
 * lifetime of this call and evicted the moment it settles. That is what
 * lets an *interactive* Ctrl-C during a live call reap the `bunx` group too
 * (previously only a timeout or CI cancellation did): the terminal-signal
 * handler below walks that same set.
 */
export async function spawnOpencodeChild(
  argv: readonly string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<OpencodeResult> {
  const [command, ...rest] = argv
  if (!command) throw new Error('spawnOpencodeChild requires a non-empty argv')

  return new Promise<OpencodeResult>((resolve) => {
    const child = spawn(
      command,
      rest,
      buildDetachedChildSpawnOptions(options.cwd, options.env),
    )
    // Multi-byte UTF-8 characters can split across chunk boundaries; letting
    // the stream decode with an encoding set keeps partial sequences buffered
    // internally instead of corrupting stdout/stderr text (and error tails).
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    const pid = child.pid
    if (pid) {
      liveRunOpencodeChildPids.add(pid)
      installTerminalSignalHandlers()
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (pid) evictRunOpencodeChildPid(pid)
      resolve({ stdout, stderr, exitCode })
    }

    const timeout = setTimeout(() => {
      void stopProcessGroup(child, 10_000).then(() => finish(-1))
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
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

/**
 * The argv prefix that launches a host's CLI: the configured binary when its
 * env var is set, else `bunx opencode-ai@<pin>` for v1. A v2 host has no
 * default launcher, so it throws when no binary is configured.
 */
export function opencodeLauncherArgv(host: OpencodeHost): string[] {
  const binary = resolveOpencodeBinary(host)
  if (binary !== undefined) return [binary]
  if (host === 'v1') {
    return [
      'bunx',
      `${OPENCODE_CLI_PACKAGES.v1}@${resolveTargetOpencodePin('v1')}`,
    ]
  }
  throw new Error(
    `no ${host} binary configured: set ${opencodeBinaryEnvName(host)} to the absolute path of an installed ${OPENCODE_CLI_PACKAGES[host]}@${resolveTargetOpencodePin(host)}`,
  )
}

/**
 * The argv for one scripted prompt. A v1 host is told the model on the command
 * line. A v2 host reads it from the config, and runs `--standalone` so the
 * test owns a private server: the default `run` starts a detached service on a
 * shared port that outlives the test.
 */
export function buildOpencodeRunArgv(
  host: OpencodeHost,
  prompt: string,
): string[] {
  const launcher = opencodeLauncherArgv(host)
  if (host === 'v2') {
    return [
      ...launcher,
      'run',
      '--standalone',
      '--print-logs',
      '--log-level',
      'warn',
      prompt,
    ]
  }
  return [
    ...launcher,
    'run',
    '--model',
    `${SCRIPTED_PROVIDER_ID}/${SCRIPTED_MODEL_ID}`,
    prompt,
  ]
}

/** The argv for a long-lived server on an OS-assigned port. */
export function buildOpencodeServeArgv(host: OpencodeHost): string[] {
  const launcher = opencodeLauncherArgv(host)
  if (host === 'v2') {
    return [...launcher, 'serve', '--hostname', '127.0.0.1', '--port', '0']
  }
  return [...launcher, 'serve', '--port', '0', '--print-logs']
}

export async function runOpencode(
  prompt: string,
  options: RunOpencodeOptions,
): Promise<OpencodeResult> {
  const { fixture, configContent, extraEnv } = options
  const host = options.host ?? TARGET_OPENCODE_HOST
  const skillName = extractSkillNameFromPrompt(prompt)
  const model = startScriptedSkillModelServer(
    skillName,
    `Loaded skill ${skillName}. Reviewing repository state now.`,
  )

  try {
    const scriptedConfigContent = withScriptedProvider(
      configContent,
      model.url,
      host,
    )
    writeHostProjectConfig(fixture, scriptedConfigContent, host)
    const childEnv = buildIsolatedOpencodeEnv(
      fixture,
      scriptedConfigContent,
      extraEnv,
      host,
    )
    const argv = buildOpencodeRunArgv(host, prompt)
    let lastResult: OpencodeResult = { stdout: '', stderr: '', exitCode: -1 }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      lastResult = await spawnOpencodeChild(argv, {
        cwd: fixture.projectDir,
        env: childEnv,
        timeoutMs: TIMEOUT_MS,
      })

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

export interface ProbePlugin {
  /** `file://` URL of the probe plugin directory. */
  url: string
  /** What the host's config lists to load the probe: the URL for v1, the directory path for v2. */
  spec: string
  capturePath: string
}

// What the v2 probe records. A v2 plugin hooks the system prompt per request
// kind, and each system part is an object whose `text` is the content. The
// `context` hook is the main request, so it maps to the `chat` kind.
function v2ProbeSource(capturePath: string): string {
  return `import fs from 'node:fs'

const capturePath = ${JSON.stringify(capturePath)}

function append(entry) {
  fs.appendFileSync(capturePath, JSON.stringify(entry) + '\\n')
}

function recordSystem(kind) {
  return (event) => {
    append({
      type: 'system',
      kind,
      input: { sessionID: event.sessionID },
      system: event.system.map((part) => part.text ?? ''),
    })
  }
}

export default {
  id: 'systematic-integration-probe',
  setup(ctx) {
    append({ type: 'loaded' })
    ctx.session.hook('context', recordSystem('chat'))
    ctx.session.hook('title', recordSystem('title'))
    ctx.session.hook('compaction', recordSystem('unknown'))
  },
}
`
}

function createProbePluginV2(fixture: IsolatedFixture): ProbePlugin {
  const probeDir = path.join(fixture.tempRoot, 'probe-plugin')
  const capturePath = path.join(fixture.tempRoot, 'probe-capture.jsonl')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.writeFileSync(
    path.join(probeDir, 'package.json'),
    JSON.stringify({
      name: 'systematic-integration-probe',
      type: 'module',
      exports: { '.': './index.js' },
    }),
  )
  fs.writeFileSync(path.join(probeDir, 'index.js'), v2ProbeSource(capturePath))
  return { url: pathToFileURL(probeDir).href, spec: probeDir, capturePath }
}

export function createProbePlugin(
  fixture: IsolatedFixture,
  host: OpencodeHost = TARGET_OPENCODE_HOST,
): ProbePlugin {
  if (host === 'v2') return createProbePluginV2(fixture)
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

  const url = pathToFileURL(probeDir).href
  return { url, spec: url, capturePath }
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

/**
 * The v2 counterpart of {@link assertWorkflowSystem}. A v2 host injects the
 * workflow block as an instruction entry inside the system message, after the
 * host's own preamble, so the block need not be the first entry. It must
 * still appear exactly once, whole and in order. The block does not name
 * `systematic_skill`, so no tool guidance is asserted.
 */
function assertWorkflowSystemV2(system: readonly string[]): void {
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
  const block = system.find((entry) => entry.includes('<SYSTEMATIC_WORKFLOWS>'))
  if (!block?.includes('</SYSTEMATIC_WORKFLOWS>')) {
    throw new Error('workflow system block was not closed')
  }
  if (
    block.indexOf('</SYSTEMATIC_WORKFLOWS>') <
    block.indexOf('<SYSTEMATIC_WORKFLOWS>')
  ) {
    throw new Error('workflow system block markers were out of order')
  }
}

function assertWorkflowSystem(
  system: readonly string[],
  host: OpencodeHost,
): void {
  if (host === 'v2') {
    assertWorkflowSystemV2(system)
    return
  }
  assertWorkflowSystemV1(system)
}

function assertWorkflowSystemV1(system: readonly string[]): void {
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

export function assertMixedVersionProbeEvents(
  events: ProbeEvent[],
  host: OpencodeHost = TARGET_OPENCODE_HOST,
): void {
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
  for (const system of workflowSystems) assertWorkflowSystem(system, host)

  for (const event of systemEvents.filter((entry) => entry.kind === 'title')) {
    if (countWorkflowBlocks(event.system) !== 0) {
      throw new Error('title transform unexpectedly received workflow block')
    }
  }
}

export interface ServerAnnouncement {
  url: string
  /** The Basic-auth password a v2 server prints; v1 prints none. */
  password?: string
}

/**
 * Reads a server's startup output. A v1 server prints its URL. A v2 server
 * prints `server listening on <url>` and then `server password <password>`,
 * possibly in a later chunk, so a v2 announcement is complete only once both
 * have arrived.
 */
export function parseServerAnnouncement(
  output: string,
  awaitPassword: boolean,
): ServerAnnouncement | undefined {
  const url = /(http:\/\/[\d.:]+)/.exec(output)?.[1]
  if (url === undefined) return undefined
  if (!awaitPassword) return { url }
  const password = /server password (\S+)/.exec(output)?.[1]
  return password === undefined ? undefined : { url, password }
}

async function startOpencodeProcess(
  fixture: IsolatedFixture,
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  options: { awaitPassword?: boolean; timeoutMs?: number } = {},
): Promise<OpencodeServer> {
  const { awaitPassword = false, timeoutMs = TIMEOUT_MS } = options
  const server = spawn(
    command,
    [...args],
    buildDetachedChildSpawnOptions(fixture.projectDir, env),
  )
  const pid = server.pid
  if (!pid) throw new Error('opencode server did not expose a process id')

  // Everything the server has written to stdout and stderr so far, for tests
  // that look for a diagnostic. The listeners stay attached after startup.
  let buffer = ''
  const announcement = await new Promise<ServerAnnouncement>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        void stopOpencodeProcess(server).then(() => {
          reject(
            new Error(`OpenCode server start timed out: ${buffer.slice(-500)}`),
          )
        })
      }, timeoutMs)

      const onChunk = (chunk: Buffer): void => {
        buffer += chunk.toString()
        const parsed = parseServerAnnouncement(buffer, awaitPassword)
        if (parsed === undefined) return
        clearTimeout(timeout)
        resolve(parsed)
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
    },
  )

  let stopped = false
  const host: OpencodeServer = {
    url: announcement.url,
    ...(announcement.password === undefined
      ? {}
      : { password: announcement.password }),
    pid,
    output: () => buffer,
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
    // This is the fast path; pruneLiveOpencodeProcesses (see its doc comment)
    // is the fallback for the case where the group was still non-empty at
    // this exact instant.
    if (!isProcessGroupAlive(pid)) liveOpencodeHosts.delete(host)
  })
  installTerminalSignalHandlers()
  return host
}

export async function startOpencodeServer(
  fixture: IsolatedFixture,
  configContent: string,
  extraEnv?: Record<string, string>,
  host: OpencodeHost = TARGET_OPENCODE_HOST,
): Promise<OpencodeServer> {
  writeHostProjectConfig(fixture, configContent, host)
  const [command, ...args] = buildOpencodeServeArgv(host)
  if (command === undefined) throw new Error('empty serve argv')
  return startOpencodeProcess(
    fixture,
    command,
    args,
    buildIsolatedOpencodeEnv(fixture, configContent, extraEnv, host),
    { awaitPassword: host === 'v2' },
  )
}

export interface OpencodeServer {
  url: string
  /** The Basic-auth password of a v2 server; absent for v1. */
  password?: string
  pid: number
  /** The server's stdout and stderr so far. */
  output(): string
  stop(): Promise<void>
}

/**
 * The request headers a v2 server needs: Basic auth as user `opencode` with the
 * password the server printed at startup. Empty for a server without one.
 */
export function opencodeServerAuthHeaders(
  server: OpencodeServer,
): Record<string, string> {
  if (server.password === undefined) return {}
  const token = Buffer.from(`opencode:${server.password}`).toString('base64')
  return { authorization: `Basic ${token}` }
}

export type OpencodeV2Client = ReturnType<
  typeof import('@opencode/client')['OpenCode']['make']
>

/**
 * A client for a running v2 server, from `@opencode/client` (the remote client;
 * `@opencode/sdk` only embeds a host in-process). Imported on demand so a v1
 * run never loads it.
 */
export async function createOpencodeV2Client(
  server: OpencodeServer,
): Promise<OpencodeV2Client> {
  const { OpenCode } = await import('@opencode/client')
  return OpenCode.make({
    baseUrl: server.url,
    headers: opencodeServerAuthHeaders(server),
  })
}

const liveOpencodeHosts = new Set<OpencodeServer>()
// Parallel to liveOpencodeHosts: pids of in-flight spawnOpencodeChild
// children (runOpencode, runOpencodeDebugConfig). A startOpencodeServer host
// outlives its call and is reaped through its own stop()/exit bookkeeping;
// a spawnOpencodeChild child has no long-lived handle, so its pid lives here
// instead, for the terminal-signal safety net below, and is evicted the
// moment the child settles (see evictRunOpencodeChildPid).
const liveRunOpencodeChildPids = new Set<number>()

let terminalSignalHandlersInstalled = false

function killProcessGroupSync(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Cleanup is best effort; the process may already be gone.
  }
}

/**
 * Only ESRCH (no such process/group) is proof a process group is gone.
 * Everything else -- including EPERM, which POSIX `kill(2)` throws when
 * the group still exists but this process lacks permission to signal it
 * -- is NOT proof of death.
 */
export function isKillErrorProofOfDeath(error: unknown): boolean {
  return isRecord(error) && error.code === 'ESRCH'
}

/**
 * `process.kill(-pid, 0)` throwing is not on its own proof the group is
 * gone -- see `isKillErrorProofOfDeath`. This is a reaper: it must never
 * drop an entry it cannot prove is actually gone, so any error that isn't
 * proof of death fails CLOSED (treats it as alive) rather than risk
 * leaking a live `opencode` process group past process exit. The negative
 * `-pid` probes the process GROUP, not the single pid.
 */
export function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return !isKillErrorProofOfDeath(error)
  }
}

/**
 * Both `liveOpencodeHosts` (startOpencodeProcess's own `exit` handler) and
 * `liveRunOpencodeChildPids` (evictRunOpencodeChildPid) are also evicted by
 * a one-shot probe at the instant their launcher process exits, as a fast
 * path. That probe only ever runs once: if the process group still has a
 * member draining at that exact instant (e.g. a grandchild not yet reaped),
 * the entry is never evicted by the fast path and would otherwise survive
 * for the rest of the worker's life -- permanently pinning
 * `hasLiveOpencodeProcesses()` to true (silently re-arming the
 * force-exit-on-signal path forever, since it would then believe something
 * is always live) and leaving a now-stale, recyclable pgid in
 * `killLiveOpencodeHostsSync`'s SIGKILL sweep, which could wrongly signal
 * an unrelated later process holding that recycled pgid. Both call sites
 * below re-probe and prune stale entries before acting: an entry is
 * removed only when the group is provably gone (ESRCH from
 * `process.kill(-pid, 0)`). Two cases are retained instead, for different
 * reasons. EPERM (group exists, not ours to signal) is retained AND
 * provably harmless in the sweep: the sweep's own
 * `process.kill(-pid, 'SIGKILL')` against that same pgid is rejected with
 * EPERM too and swallowed, so a retained entry never lets this worker
 * signal a group it has no permission to touch. An unrecognized error
 * code is retained on the general reaper principle -- never drop an entry
 * you cannot prove is gone -- though for a valid integer pid with signal
 * 0, POSIX `kill(2)` yields only EPERM or ESRCH, so this branch is
 * effectively unreachable; anything else Node could throw here
 * (`ERR_INVALID_ARG_TYPE`, `ERR_OUT_OF_RANGE`) would be a programming
 * error, not a runtime process-group state.
 */
function pruneLiveOpencodeProcesses(): void {
  for (const host of liveOpencodeHosts) {
    if (!isProcessGroupAlive(host.pid)) liveOpencodeHosts.delete(host)
  }
  for (const pid of liveRunOpencodeChildPids) {
    if (!isProcessGroupAlive(pid)) liveRunOpencodeChildPids.delete(pid)
  }
}

function killLiveOpencodeHostsSync(): void {
  pruneLiveOpencodeProcesses()
  for (const host of liveOpencodeHosts) killProcessGroupSync(host.pid)
  for (const pid of liveRunOpencodeChildPids) killProcessGroupSync(pid)
}

function evictRunOpencodeChildPid(pid: number): void {
  // Mirrors startOpencodeProcess's own exit-handler eviction probe: a pgid
  // cannot be recycled while its group still has members, so this pid is
  // only forgotten once the group is provably empty. Otherwise a recycled
  // pgid from some unrelated later process could be mistaken for still-live
  // and wrongly signalled by killLiveOpencodeHostsSync. This is the fast
  // path; pruneLiveOpencodeProcesses is the fallback for the case where the
  // group was still non-empty at this exact instant (see its doc comment).
  if (!isProcessGroupAlive(pid)) liveRunOpencodeChildPids.delete(pid)
}

export function hasLiveOpencodeProcesses(): boolean {
  pruneLiveOpencodeProcesses()
  return liveOpencodeHosts.size > 0 || liveRunOpencodeChildPids.size > 0
}

/**
 * Terminal-signal safety net for every real `opencode` process this fixture
 * spawns: long-lived hosts in `liveOpencodeHosts`, one-shot
 * `spawnOpencodeChild` children in `liveRunOpencodeChildPids`. This is the
 * root-cause fix for a full-suite exit 130: the handler used to reap and
 * force-exit(130) unconditionally, even with nothing live, so a Ctrl-C
 * during ANY part of the suite -- not just a live host run -- looked
 * indistinguishable from an interrupted host and killed the whole runner.
 * Now, when nothing is live it returns without exiting, leaving other
 * SIGINT/SIGTERM listeners to run. Only when something is actually live
 * does it reap the group(s) and force-exit -- skipping remaining afterAll
 * hooks (temp dirs may leak) is an acceptable tradeoff only when there is a
 * real orphaned-host-process risk to avoid.
 */
function installTerminalSignalHandlers(): void {
  if (terminalSignalHandlersInstalled) return
  terminalSignalHandlersInstalled = true

  process.on('SIGINT', () => {
    if (!hasLiveOpencodeProcesses()) return
    killLiveOpencodeHostsSync()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    if (!hasLiveOpencodeProcesses()) return
    killLiveOpencodeHostsSync()
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

/** The OpenCode plugin package each host's plugin imports types from. */
const HOST_PLUGIN_PACKAGES = {
  v1: '@opencode-ai/plugin',
  v2: '@opencode/plugin',
} as const satisfies Record<OpencodeHost, string>

/**
 * Unpacks the packed plugin into the fixture project and links its runtime
 * dependencies from this repository. `pluginUrl` is the package directory as a
 * `file://` URL, the v1 config form. `pluginSpec` is the entry a host's config
 * lists: the URL for v1, the directory path for v2.
 */
export function extractPackagedPlugin(
  fixture: IsolatedFixture,
  host: OpencodeHost = TARGET_OPENCODE_HOST,
): {
  packageDir: string
  pluginUrl: string
  pluginSpec: string
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
  linkRuntimeDependency(fixture, HOST_PLUGIN_PACKAGES[host])

  const pluginUrl = pathToFileURL(packageDir).href
  return {
    packageDir,
    pluginUrl,
    pluginSpec: host === 'v2' ? packageDir : pluginUrl,
  }
}
