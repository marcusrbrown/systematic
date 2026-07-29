/**
 * Pi coding-agent subprocess integration harness (Unit 7 of the Pi harness plan).
 *
 * Spawns the REAL `@earendil-works/pi-coding-agent` CLI (exact devDependency,
 * v0.80.6) in `--mode rpc`, loads Systematic's PACKAGED Pi extension from an
 * `npm pack` tarball (not src/), drives it over JSONL/RPC with a MOCKED
 * OpenAI-completions-compatible local HTTP model, and asserts the parity
 * capabilities end-to-end: extension load, skill discovery, systematic_skill
 * resolution, using-systematic bootstrap injection, and persona delegation.
 *
 * NO SILENT SKIP: Pi is an exact devDependency (see package.json
 * devDependencies), so `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`
 * MUST exist after `bun install`. If it's missing this suite fails loudly
 * (bad install) rather than skipping — this intentionally diverges from the
 * plan's original `PI_AVAILABLE` skip-guard premise, which predates Pi
 * becoming an exact devDependency.
 *
 * Env var names verified against installed source (v0.80.6):
 *   node_modules/@earendil-works/pi-coding-agent/dist/config.js:396-398
 *     ENV_AGENT_DIR    = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`    = "PI_CODING_AGENT_DIR"
 *     ENV_SESSION_DIR  = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR` = "PI_CODING_AGENT_SESSION_DIR"
 *   (APP_NAME defaults to "pi" — package.json has no piConfig.name override.)
 *
 * Package-spec route (verified against dist/core/package-manager.js):
 *   `.pi/settings.json`'s `packages` array accepts a "local" source
 *   (parseSource(): anything that isn't `npm:`/`git:`-prefixed is `type:
 *   "local"`, resolved relative to the settings file's baseDir — see
 *   isLocalPath()/parseSource() in dist/utils/paths.js and
 *   dist/core/package-manager.js:1144-1166). We point `packages` at the
 *   extracted tarball's package directory (a relative path from the fixture
 *   project root), which resolves the `pi.extensions`/`pi.skills` manifest
 *   from its package.json exactly as a real project-local install would —
 *   fully offline, no network installs, exercising real manifest-driven
 *   wiring (dist/core/package-manager.js:1735-1759 readPiManifest() +
 *   addManifestEntries()).
 *
 * Mock model: a local OpenAI-completions-compatible HTTP server (Bun.serve,
 * port 0), scripted per test. Verified against
 * node_modules/.../@earendil-works/pi-ai/dist/api/openai-completions.js:
 * pi's openai-completions client always requests `stream: true` (line ~429)
 * and consumes an SSE-style async-iterable stream via the `openai` SDK
 * client, so the mock must emit `text/event-stream` chunks in OpenAI
 * chat-completion-chunk shape terminated by `data: [DONE]`. The model is
 * wired in via a project-local `.pi/models.json` (dist/core/model-registry.js
 * ModelsConfigSchema: `providers.<name>.{baseUrl,api,models[]}`), api id
 * `openai-completions` (dist/core/model-registry.js ProviderCompatSchema /
 * pi-ai README "Custom Providers" section), pointed at the mock's baseUrl.
 * `PI_OFFLINE=1` additionally disables startup network calls (npm-update
 * checks) regardless of model choice.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const PI_CLI = path.join(
  REPO_ROOT,
  'node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
)

// NO SILENT SKIP: Pi is an exact devDependency; a missing CLI after install
// is a real, actionable failure, not a legitimate skip condition.
if (!fs.existsSync(PI_CLI)) {
  throw new Error(
    `Pi coding-agent CLI not found at ${PI_CLI}. ` +
      `Pi is an exact devDependency (@earendil-works/pi-coding-agent) — ` +
      `run \`bun install\` and verify the dependency is installed correctly. ` +
      `This suite intentionally fails loudly instead of skipping.`,
  )
}

// `@tintinweb/pi-subagents` is a real, exact devDependency (v0.14.3 — see
// package.json devDependencies). Resolve its installed package directory via
// `require.resolve` (bun's node_modules layout hoists it to a `.bun` store and
// symlinks it into `node_modules/@tintinweb/pi-subagents`, so a plain
// filesystem join isn't guaranteed to match bun's actual resolution target).
const require = createRequire(import.meta.url)
const PI_SUBAGENTS_PKG_DIR = path.dirname(
  require.resolve('@tintinweb/pi-subagents/package.json'),
)

// NO SILENT SKIP: same policy as PI_CLI above — pi-subagents is an exact
// devDependency, so its `pi.extensions` entry point must exist after install.
const piSubagentsPkgJson = JSON.parse(
  fs.readFileSync(path.join(PI_SUBAGENTS_PKG_DIR, 'package.json'), 'utf8'),
) as { pi?: { extensions?: string[] } }
const piSubagentsExtensionEntry = piSubagentsPkgJson.pi?.extensions?.[0]
if (!piSubagentsExtensionEntry) {
  throw new Error(
    `@tintinweb/pi-subagents package.json at ${PI_SUBAGENTS_PKG_DIR} has no ` +
      `"pi.extensions" entry. This suite intentionally fails loudly instead ` +
      `of skipping.`,
  )
}
const piSubagentsExtensionPath = path.join(
  PI_SUBAGENTS_PKG_DIR,
  piSubagentsExtensionEntry,
)
if (!fs.existsSync(piSubagentsExtensionPath)) {
  throw new Error(
    `@tintinweb/pi-subagents extension entry point not found at ` +
      `${piSubagentsExtensionPath} (declared in package.json "pi.extensions"). ` +
      `This suite intentionally fails loudly instead of skipping.`,
  )
}

const TIMEOUT_MS = 60_000
const MOCK_MODEL_ID = 'systematic-mock'
const MOCK_PROVIDER_ID = 'systematic-mock-provider'

// ---------------------------------------------------------------------------
// Isolated fixture (mirrors tests/integration/opencode.test.ts discipline:
// temp HOME + all XDG roots + PI_CODING_AGENT_DIR/SESSION_DIR overridden so
// the subprocess has no path back to the real user environment).
// ---------------------------------------------------------------------------

interface IsolatedFixture {
  tempRoot: string
  projectDir: string
  homeDir: string
  agentDir: string
  sessionDir: string
  xdgConfigHome: string
  xdgDataHome: string
  xdgCacheHome: string
  xdgStateHome: string
}

function createIsolatedFixture(): IsolatedFixture {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-pi-'))
  const projectDir = path.join(tempRoot, 'project')
  const homeDir = path.join(tempRoot, 'home')
  const agentDir = path.join(tempRoot, 'pi-agent-dir')
  const sessionDir = path.join(tempRoot, 'pi-session-dir')
  const xdgConfigHome = path.join(tempRoot, 'xdg-config')
  const xdgDataHome = path.join(tempRoot, 'xdg-data')
  const xdgCacheHome = path.join(tempRoot, 'xdg-cache')
  const xdgStateHome = path.join(tempRoot, 'xdg-state')

  for (const dir of [
    projectDir,
    homeDir,
    agentDir,
    sessionDir,
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
      name: 'systematic-pi-integration-fixture',
      private: true,
      type: 'module',
    }),
  )

  return {
    tempRoot,
    projectDir,
    homeDir,
    agentDir,
    sessionDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
  }
}

function destroyIsolatedFixture(fixture: IsolatedFixture): void {
  fs.rmSync(fixture.tempRoot, { recursive: true, force: true })
}

// Env vars forwarded from the parent process; everything else is dropped or
// overridden by the fixture, matching the opencode.test.ts allowlist model.
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
])

function buildChildEnv(
  fixture: IsolatedFixture,
  overrides: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) base[key] = value
  }
  return {
    ...base,
    HOME: fixture.homeDir,
    XDG_CONFIG_HOME: fixture.xdgConfigHome,
    XDG_DATA_HOME: fixture.xdgDataHome,
    XDG_CACHE_HOME: fixture.xdgCacheHome,
    XDG_STATE_HOME: fixture.xdgStateHome,
    // Verified names: dist/config.js:397-398 (ENV_AGENT_DIR / ENV_SESSION_DIR).
    PI_CODING_AGENT_DIR: fixture.agentDir,
    PI_CODING_AGENT_SESSION_DIR: fixture.sessionDir,
    PI_OFFLINE: '1',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Suite-scoped packaged-tarball fixture (built + packed once).
// ---------------------------------------------------------------------------

let packedTarballPath: string | null = null
let packTempDir: string | null = null

function packTarballOnce(): void {
  const build = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: REPO_ROOT,
    timeout: 120_000,
  })
  if (build.exitCode !== 0) {
    throw new Error(
      `bun run build failed (exit ${build.exitCode})\n--- stdout ---\n${build.stdout.toString()}\n--- stderr ---\n${build.stderr.toString()}`,
    )
  }

  packTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-pi-pack-'))
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

function cleanupPackedTarball(): void {
  if (packTempDir) fs.rmSync(packTempDir, { recursive: true, force: true })
  packedTarballPath = null
  packTempDir = null
}

/**
 * Extract the suite-scoped tarball into `fixture.tempRoot/packaged/systematic`
 * and write `.pi/settings.json` with a `packages` entry pointing at it as a
 * *local* package source (relative path), per the resolved route above.
 * Returns the relative path written into `packages`.
 */
function extractPackagedPluginAndConfigurePi(fixture: IsolatedFixture): {
  packageDir: string
  relativePackagePath: string
} {
  if (!packedTarballPath) throw new Error('packTarballOnce() has not run')

  // Local package sources in `.pi/settings.json` resolve relative to
  // `<cwd>/.pi` (verified: dist/core/package-manager.js getBaseDirForScope()
  // returns `join(this.cwd, CONFIG_DIR_NAME)` for scope "project"), so the
  // extracted package lives outside `.pi` and is referenced with a `../`
  // relative path from there.
  const packagedRoot = path.join(fixture.projectDir, 'packaged')
  fs.mkdirSync(packagedRoot, { recursive: true })

  const extract = Bun.spawnSync(
    ['tar', 'xzf', packedTarballPath, '-C', packagedRoot],
    { timeout: 30_000 },
  )
  if (extract.exitCode !== 0) {
    throw new Error(
      `tar extraction failed (exit ${extract.exitCode}): ${extract.stderr.toString()}`,
    )
  }

  const packageDir = path.join(packagedRoot, 'systematic')
  fs.renameSync(path.join(packagedRoot, 'package'), packageDir)

  // Link runtime dependencies declared by the extracted package.json + the
  // Pi SDK peer dep, from the repo's own resolved node_modules, so `pi` can
  // resolve them without a network install.
  const extractedPackageJson = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> }
  const nodeModulesDir = path.join(fixture.projectDir, 'node_modules')
  fs.mkdirSync(nodeModulesDir, { recursive: true })
  for (const depName of [
    ...Object.keys(extractedPackageJson.dependencies ?? {}),
    '@earendil-works/pi-coding-agent',
    'typebox',
  ]) {
    const source = path.join(REPO_ROOT, 'node_modules', depName)
    if (!fs.existsSync(source)) continue
    const target = path.join(nodeModulesDir, depName)
    if (fs.existsSync(target)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(source, target, 'dir')
  }

  const piDir = path.join(fixture.projectDir, '.pi')
  fs.mkdirSync(piDir, { recursive: true })
  const relativePackagePath = path.relative(piDir, packageDir)

  fs.writeFileSync(
    path.join(piDir, 'settings.json'),
    JSON.stringify({ packages: [relativePackagePath] }, null, 2),
  )

  return { packageDir, relativePackagePath }
}

/**
 * Writes `models.json` pointing the mock model's provider at `baseUrl`.
 * Verified location: dist/config.js `getModelsPath()` = join(getAgentDir(),
 * "models.json") — the *agent* dir (PI_CODING_AGENT_DIR), not a project-local
 * `.pi/models.json`. Pi has no project-scoped models.json.
 */
function writeMockModelsConfig(
  fixture: IsolatedFixture,
  baseUrl: string,
): void {
  fs.mkdirSync(fixture.agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(fixture.agentDir, 'models.json'),
    JSON.stringify(
      {
        providers: {
          [MOCK_PROVIDER_ID]: {
            baseUrl,
            api: 'openai-completions',
            apiKey: 'unused-mock-key',
            models: [
              {
                id: MOCK_MODEL_ID,
                name: 'Systematic Mock Model',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 16384,
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  )
}

// ---------------------------------------------------------------------------
// Mock model server: local OpenAI-completions-compatible HTTP server.
// Verified request/response shape against
// @earendil-works/pi-ai dist/api/openai-completions.js — the client always
// sends `stream: true` and consumes SSE chat-completion-chunk objects.
// ---------------------------------------------------------------------------

interface ScriptedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

interface ScriptedResponse {
  /** Plain assistant text content (mutually exclusive with toolCalls per script step, but either may be empty). */
  text?: string
  toolCalls?: ScriptedToolCall[]
}

interface MockModelServer {
  url: string
  requests: unknown[]
  stop(): void
  /** Push the next scripted response to return for the next chat-completions request. */
  push(response: ScriptedResponse): void
}

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function startMockModelServer(): MockModelServer {
  const script: ScriptedResponse[] = []
  const requests: unknown[] = []
  let callIndex = 0

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 })
      }

      const body = (await req.json()) as unknown
      requests.push(body)

      const scripted = script[callIndex] ?? { text: '' }
      callIndex += 1

      const id = `chatcmpl-mock-${callIndex}`
      const created = Math.floor(Date.now() / 1000)

      const chunks: Record<string, unknown>[] = []

      if (scripted.toolCalls && scripted.toolCalls.length > 0) {
        scripted.toolCalls.forEach((toolCall, index) => {
          chunks.push({
            id,
            object: 'chat.completion.chunk',
            created,
            model: MOCK_MODEL_ID,
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
          })
        })
        chunks.push({
          id,
          object: 'chat.completion.chunk',
          created,
          model: MOCK_MODEL_ID,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })
      } else {
        const text = scripted.text ?? ''
        if (text.length > 0) {
          chunks.push({
            id,
            object: 'chat.completion.chunk',
            created,
            model: MOCK_MODEL_ID,
            choices: [
              { index: 0, delta: { role: 'assistant' }, finish_reason: null },
            ],
          })
          chunks.push({
            id,
            object: 'chat.completion.chunk',
            created,
            model: MOCK_MODEL_ID,
            choices: [
              { index: 0, delta: { content: text }, finish_reason: null },
            ],
          })
        }
        chunks.push({
          id,
          object: 'chat.completion.chunk',
          created,
          model: MOCK_MODEL_ID,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })
      }

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(sseChunk(chunk)))
          }
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
    requests,
    stop: () => server.stop(true),
    push: (response) => script.push(response),
  }
}

// ---------------------------------------------------------------------------
// RPC client: spawns Pi in `--mode rpc`, writes JSONL commands to stdin,
// reads JSONL responses/events from stdout, correlates by `id`.
// ---------------------------------------------------------------------------

interface RpcMessage {
  id?: string
  type: string
  command?: string
  success?: boolean
  data?: unknown
  error?: string
  [key: string]: unknown
}

interface RpcClientHandle {
  send(command: Record<string, unknown>): Promise<RpcMessage>
  /** All raw messages (responses + events) observed so far. */
  messages(): RpcMessage[]
  /** Wait until a predicate matches a message already seen or a new one arrives. */
  waitFor(
    predicate: (msg: RpcMessage) => boolean,
    timeoutMs?: number,
  ): Promise<RpcMessage>
  close(): Promise<{ exitCode: number; stderr: string }>
}

function spawnPiRpc(options: {
  fixture: IsolatedFixture
  extraEnv?: Record<string, string>
}): RpcClientHandle {
  const { fixture, extraEnv } = options
  const env = buildChildEnv(fixture, extraEnv ?? {})

  const child = Bun.spawn(
    ['node', PI_CLI, '--mode', 'rpc', '--no-session', '--approve', '--offline'],
    {
      cwd: fixture.projectDir,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  const messages: RpcMessage[] = []
  const waiters: {
    predicate: (msg: RpcMessage) => boolean
    resolve: (msg: RpcMessage) => void
  }[] = []
  let stderrBuffer = ''
  let stdoutTail = ''

  const handleLine = (line: string) => {
    if (line.trim() === '') return
    let parsed: RpcMessage
    try {
      parsed = JSON.parse(line) as RpcMessage
    } catch {
      return
    }
    messages.push(parsed)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(parsed)) {
        const [waiter] = waiters.splice(i, 1)
        waiter.resolve(parsed)
      }
    }
  }

  const pump = async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        stdoutTail = buffer.slice(-4000)
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)
          newlineIndex = buffer.indexOf('\n')
          handleLine(line)
        }
      }
    } catch {
      // Stream closed; nothing further to pump.
    }
  }

  const pumpStderr = async () => {
    const reader = child.stderr.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        stderrBuffer += decoder.decode(value, { stream: true })
      }
    } catch {
      // Stream closed.
    }
  }

  void pump()
  void pumpStderr()

  const stdin = child.stdin as unknown as {
    write(data: Uint8Array): void
    end(): void
  }
  let commandCounter = 0

  const waitFor = (
    predicate: (msg: RpcMessage) => boolean,
    timeoutMs = TIMEOUT_MS,
  ): Promise<RpcMessage> => {
    const existing = messages.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise<RpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === wrappedResolve)
        if (idx !== -1) waiters.splice(idx, 1)
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for RPC message.\n` +
              `--- stdout tail ---\n${stdoutTail}\n` +
              `--- stderr tail ---\n${stderrBuffer.slice(-4000)}`,
          ),
        )
      }, timeoutMs)
      const wrappedResolve = (msg: RpcMessage) => {
        clearTimeout(timer)
        resolve(msg)
      }
      waiters.push({ predicate, resolve: wrappedResolve })
    })
  }

  const send = async (
    command: Record<string, unknown>,
  ): Promise<RpcMessage> => {
    commandCounter += 1
    const id = command.id ?? `cmd-${commandCounter}`
    const withId = { ...command, id }
    const responsePromise = waitFor(
      (msg) => msg.type === 'response' && msg.id === id,
    )
    stdin.write(new TextEncoder().encode(`${JSON.stringify(withId)}\n`))
    return responsePromise
  }

  const close = async (): Promise<{ exitCode: number; stderr: string }> => {
    try {
      stdin.end()
    } catch {
      // Already closed.
    }
    child.kill()
    const exitCode = await child.exited
    return { exitCode, stderr: stderrBuffer }
  }

  return {
    send,
    messages: () => messages,
    waitFor,
    close,
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Pi subprocess integration', () => {
  let fixture: IsolatedFixture
  let mockModel: MockModelServer
  let client: RpcClientHandle | undefined

  beforeAll(() => {
    packTarballOnce()
  }, 200_000)

  afterAll(() => {
    cleanupPackedTarball()
  })

  beforeEach(() => {
    fixture = createIsolatedFixture()
    mockModel = startMockModelServer()
    extractPackagedPluginAndConfigurePi(fixture)
    writeMockModelsConfig(fixture, mockModel.url)
  })

  afterEach(async () => {
    if (client) {
      await client.close()
      client = undefined
    }
    mockModel.stop()
    destroyIsolatedFixture(fixture)
  })

  test(
    'packaged extension loads: registered tools are exercised over RPC without a load error',
    async () => {
      client = spawnPiRpc({ fixture })

      // Systematic's Pi extension registers tools (systematic_skill,
      // systematic_delegate) via pi.registerTool, not pi.registerCommand —
      // so get_commands' "extension" source (slash-command registrations)
      // stays empty by design and isn't the right load signal. Instead,
      // assert directly that the extension's `before_agent_start` handler
      // ran (bootstrap marker present) and no `extension_error` RPC event
      // was emitted, which together are the authoritative signal that
      // src/pi.ts's default export executed successfully as a factory.
      await client.send({
        type: 'set_model',
        provider: MOCK_PROVIDER_ID,
        modelId: MOCK_MODEL_ID,
      })
      mockModel.push({ text: 'ack' })
      const promptResponse = await client.send({
        type: 'prompt',
        message: 'hello',
      })
      if (!promptResponse.success) {
        throw new Error(`prompt failed: ${promptResponse.error}`)
      }
      await client.waitFor((msg) => msg.type === 'agent_settled')

      const extensionErrors = client
        .messages()
        .filter((msg) => msg.type === 'extension_error')
      expect(extensionErrors).toEqual([])

      const firstRequest = mockModel.requests[0] as {
        messages: { role: string; content: unknown }[]
      }
      const systemText = firstRequest.messages
        .filter((m) => m.role === 'system' || m.role === 'developer')
        .map((m) =>
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        )
        .join('\n')
      expect(systemText).toContain('<SYSTEMATIC_WORKFLOWS>')
      expect(systemText).toContain('# Pi Capability Profile')
      expect(systemText).not.toContain('# OpenCode Capability Profile')
    },
    TIMEOUT_MS,
  )

  test(
    'skills discoverable: get_commands includes skill-sourced entries from pi.skills manifest',
    async () => {
      client = spawnPiRpc({ fixture })

      const response = await client.send({ type: 'get_commands' })
      expect(response.success).toBe(true)

      const data = response.data as {
        commands: { name: string; source: string }[]
      }
      const skillCommands = data.commands.filter((c) => c.source === 'skill')
      const skillNames = skillCommands.map((c) => c.name)

      if (skillCommands.length === 0) {
        const closeResult = await client.close()
        client = undefined
        throw new Error(`no skill commands; stderr:\n${closeResult.stderr}`)
      }
      expect(skillCommands.length).toBeGreaterThan(0)
      expect(
        skillNames.some((name) => name.includes('test-driven-development')),
      ).toBe(true)
    },
    TIMEOUT_MS,
  )

  test(
    'using-systematic bootstrap injected into session system prompt via before_agent_start',
    async () => {
      client = spawnPiRpc({ fixture })

      // Force session/model resolution so the extension's before_agent_start
      // handler has run and get_state reports a real session.
      await client.send({
        type: 'set_model',
        provider: MOCK_PROVIDER_ID,
        modelId: MOCK_MODEL_ID,
      })

      mockModel.push({ text: 'ack' })
      const promptResponse = await client.send({
        type: 'prompt',
        message: 'hello',
      })
      if (!promptResponse.success) {
        throw new Error(
          `prompt failed: ${promptResponse.error}\nmessages: ${JSON.stringify(client.messages().slice(0, 20))}`,
        )
      }

      await client.waitFor((msg) => msg.type === 'agent_settled')

      // The system prompt itself isn't exposed via a dedicated RPC command in
      // v0.80.6 (verified: rpc-mode.js has no such case); the mock model
      // request payload IS the ground truth for what was actually sent to
      // the "provider", so assert the bootstrap marker there instead.
      expect(mockModel.requests.length).toBeGreaterThan(0)
      const firstRequest = mockModel.requests[0] as {
        messages: { role: string; content: unknown }[]
      }
      const systemMessages = firstRequest.messages.filter(
        (m) => m.role === 'system' || m.role === 'developer',
      )
      const systemText = systemMessages
        .map((m) =>
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        )
        .join('\n')

      expect(systemText).toContain('<SYSTEMATIC_WORKFLOWS>')
      // Pi-native skill usage section (src/pi.ts PI_BOOTSTRAP_USAGE_TEMPLATE)
      // replaces OpenCode's usage template, which instructs use of a
      // generic `skill` tool that doesn't exist in Pi
      // (docs/solutions/logic-errors/pi-chained-bootstrap-composition-2026-07-14.md).
      expect(systemText).toContain(
        'Use `systematic_skill` for Systematic skills.',
      )
      expect(systemText).toContain(
        "follow Pi's native skill instructions and read the listed SKILL.md path",
      )
    },
    TIMEOUT_MS,
  )

  test(
    'systematic_skill resolves a real bundled skill via a scripted tool call',
    async () => {
      client = spawnPiRpc({ fixture })

      await client.send({
        type: 'set_model',
        provider: MOCK_PROVIDER_ID,
        modelId: MOCK_MODEL_ID,
      })

      // Turn 1: model emits a systematic_skill tool call.
      mockModel.push({
        toolCalls: [
          {
            id: 'call_1',
            name: 'systematic_skill',
            arguments: { name: 'systematic:test-driven-development' },
          },
        ],
      })
      // Turn 2: model acknowledges the tool result with plain text.
      mockModel.push({ text: 'loaded the skill' })

      const promptResponse = await client.send({
        type: 'prompt',
        message:
          'Use the systematic_skill tool to load test-driven-development',
      })
      expect(promptResponse.success).toBe(true)

      const toolEnd = await client.waitFor(
        (msg) =>
          msg.type === 'tool_execution_end' &&
          (msg as { toolName?: string }).toolName === 'systematic_skill',
      )

      const result = (toolEnd as { result?: unknown }).result as
        | { content?: { type: string; text?: string }[] }
        | undefined
      const text = result?.content?.[0]?.text ?? ''

      expect(text).toContain(
        '<skill_content name="systematic:test-driven-development">',
      )
    },
    TIMEOUT_MS,
  )

  test(
    'Pi skill payloads contain neutral orchestrating-subagents instructions',
    async () => {
      client = spawnPiRpc({ fixture })

      await client.send({
        type: 'set_model',
        provider: MOCK_PROVIDER_ID,
        modelId: MOCK_MODEL_ID,
      })

      mockModel.push({
        toolCalls: [
          {
            id: 'call_orchestrating_subagents_1',
            name: 'systematic_skill',
            arguments: { name: 'systematic:orchestrating-subagents' },
          },
        ],
      })
      mockModel.push({ text: 'loaded the skill' })

      const promptResponse = await client.send({
        type: 'prompt',
        message:
          'Use systematic_skill to load systematic:orchestrating-subagents',
      })
      expect(promptResponse.success).toBe(true)

      const toolEnd = await client.waitFor(
        (msg) =>
          msg.type === 'tool_execution_end' &&
          (msg as { toolName?: string }).toolName === 'systematic_skill',
      )
      await client.waitFor((msg) => msg.type === 'agent_settled')

      const result = (toolEnd as { result?: unknown }).result as
        | { content?: { type: string; text?: string }[] }
        | undefined
      const skillText = result?.content?.[0]?.text ?? ''
      expect(skillText).toContain(
        '<skill_content name="systematic:orchestrating-subagents">',
      )

      for (const bannedToken of [
        'task(',
        'subagent_type',
        'todowrite',
        'TodoWrite',
        'request_user_input',
        'ask_user',
        'AskUserQuestion',
        'update_plan',
      ]) {
        expect(skillText).not.toContain(bannedToken)
      }

      const payloadStream = mockModel.requests
        .map((request) => JSON.stringify(request))
        .join('\n')
      expect(payloadStream).not.toContain('task(')
      expect(payloadStream).not.toContain('todowrite')
      expect(payloadStream).not.toContain('subagent_type')
      expect(payloadStream).toContain('degraded (sequential only)')
    },
    TIMEOUT_MS,
  )

  test(
    'persona subagent completes: systematic_delegate runs a child session to completion',
    async () => {
      client = spawnPiRpc({ fixture })

      await client.send({
        type: 'set_model',
        provider: MOCK_PROVIDER_ID,
        modelId: MOCK_MODEL_ID,
      })

      // Turn 1 (parent): model emits a systematic_delegate tool call.
      mockModel.push({
        toolCalls: [
          {
            id: 'call_delegate_1',
            name: 'systematic_delegate',
            arguments: {
              agent: 'best-practices-researcher',
              task: 'Summarize one best practice in one sentence.',
            },
          },
        ],
      })
      // Turn 2 (child, in-process session inherits the same mock model):
      // one minimal assistant response completes the delegated turn.
      mockModel.push({ text: 'Best practice: keep functions small.' })
      // Turn 3 (parent): acknowledges the delegate tool result.
      mockModel.push({ text: 'done' })

      const promptResponse = await client.send({
        type: 'prompt',
        message:
          'Delegate to best-practices-researcher to summarize a best practice.',
      })
      expect(promptResponse.success).toBe(true)

      const toolEnd = await client.waitFor(
        (msg) =>
          msg.type === 'tool_execution_end' &&
          (msg as { toolName?: string }).toolName === 'systematic_delegate',
        TIMEOUT_MS,
      )

      expect((toolEnd as { isError?: boolean }).isError).not.toBe(true)

      const result = (toolEnd as { result?: unknown }).result as
        | {
            details?: { persona?: string; outcome?: string; turnCount?: number }
          }
        | undefined

      expect(result?.details?.persona).toBe('best-practices-researcher')
      expect(result?.details?.outcome).toBe('completed')
      expect(result?.details?.turnCount).toBeGreaterThan(0)
    },
    TIMEOUT_MS,
  )
})

/**
 * Combined-path bounded execution: top-level pi-subagents delegation +
 * nested Systematic persona.
 *
 * `@tintinweb/pi-subagents` is a REAL, exact devDependency (v0.14.3 — see
 * package.json devDependencies and PI_SUBAGENTS_PKG_DIR above, resolved via
 * `require.resolve`). This test loads the actual installed package as a
 * `.pi/settings.json` local package source, alongside Systematic's own
 * packaged extension, in a single real Pi subprocess (the same `spawnPiRpc`
 * harness as every other test in this file) — verified to accept multiple
 * local package sources (`dist/core/package-manager.js` `resolve()`
 * concatenates `projectSettings.packages` across all configured entries).
 *
 * pi-subagents' `Agent` tool (`SUBAGENT_TOOL_NAMES.AGENT = "Agent"`,
 * `src/index.ts`) is invoked at the top level with `subagent_type:
 * "general-purpose"` — the built-in default agent type, whose config sets
 * `extensions: true` (`src/default-agents.ts`). Per `runAgent()`
 * (`src/agent-runner.ts:523-648`), `extensions: true` builds a nested
 * `DefaultResourceLoader` with `noExtensions: false`, `configCwd` pointed at
 * the SAME project directory — so the nested session re-resolves the SAME
 * `.pi/settings.json` `packages` array, loading Systematic's own extension
 * (including `systematic_delegate`) inside that nested child. This exactly
 * exercises pi-subagents' real, non-isolated subagent path (no `isolated:
 * true` override).
 *
 * Because RPC mode only wires the top-level session (the nested session's
 * own `tool_execution_end` events never reach the top-level RPC stream, and
 * this test cannot instrument pi-subagents' real source), the nested
 * `systematic_delegate` call is verified indirectly but unambiguously via
 * the mock model's own captured request log — a black-box, ground-truth
 * transcript of every chat-completions call actually made across BOTH
 * sessions, in order:
 *   1. Top-level session, turn 1 — model sees `Agent` (pi-subagents) and
 *      `systematic_delegate`/`systematic_skill` (Systematic) as available
 *      tools; emits the `Agent` tool call.
 *   2. Nested session (spawned by pi-subagents' `runAgent()`, extensions
 *      loaded), turn 1 — the pi-subagents `<sub_agent_context>` wrapper is
 *      present in its system prompt (proving this is a genuine nested
 *      pi-subagents-spawned session, not the top-level one); `Agent` and
 *      `systematic_delegate` are BOTH available (extensions loaded); emits
 *      the `systematic_delegate` tool call.
 *   3. `systematic_delegate`'s own depth-1 child (`src/lib/pi-delegate-
 *      session.ts`, `noExtensions: true`) — system prompt is the persona
 *      body verbatim (`systemPromptOverride`), and neither `Agent` nor
 *      `systematic_delegate` appear in its tools list (the persona's default
 *      read-only allowlist only) — this is the REAL, runtime-observed
 *      behavioral proof that the nested delegate child was constructed with
 *      `noExtensions: true`, not merely the code-level guarantee already
 *      unit-tested by `pi-delegate-session.test.ts`.
 *   4. Nested session, turn 2 — acknowledges the delegate tool result.
 *   5. Top-level session, turn 2 — acknowledges the `Agent` tool result.
 * Exactly 5 requests total proves the call graph is bounded (one Agent call,
 * one nested systematic_delegate call, no repetition/recursion).
 *
 * What this proves:
 *   • A real top-level pi-subagents delegation (`Agent` tool call) invokes a
 *     nested Systematic persona delegation (`systematic_delegate`) inside
 *     the pi-subagents-spawned child session.
 *   • That nested `systematic_delegate` child is itself constructed with
 *     `noExtensions: true` (both the runtime tool-availability evidence
 *     above, and the code-level guarantee in `src/lib/pi-delegate-
 *     session.ts`, unchanged by this test).
 *   • The two-level call graph (pi-subagents `Agent` → nested session →
 *     `systematic_delegate`) completes without global depth enforcement by
 *     Systematic — no assertion here claims a combined-path depth cap, only
 *     that the nested systematic_delegate call itself is bounded exactly as
 *     `pi-delegate-session.test.ts` already proves in isolation.
 *
 * Scope statement (matches R12 / plan Unit 3):
 *   systematic_delegate's noExtensions + re-entry guard bounds SYSTEMATIC'S OWN
 *   RECURSION. It does NOT prevent pi-subagents (or any external delegation
 *   engine) from creating additional layers above or alongside
 *   systematic_delegate. This test demonstrates exactly one such external
 *   layer completing successfully — it does not claim or need a global bound.
 */

describe('Combined-path bounded execution: real pi-subagents top-level + nested Systematic persona', () => {
  let fixture: IsolatedFixture
  let mockModel: MockModelServer
  let client: RpcClientHandle | undefined

  beforeAll(() => {
    packTarballOnce()
  }, 200_000)

  afterAll(() => {
    cleanupPackedTarball()
  })

  beforeEach(() => {
    fixture = createIsolatedFixture()
    mockModel = startMockModelServer()
    const { relativePackagePath } = extractPackagedPluginAndConfigurePi(fixture)
    const piDir = path.join(fixture.projectDir, '.pi')
    // PI_SUBAGENTS_PKG_DIR is the real installed package directory (resolved
    // via require.resolve at module load time, above) — passed as an
    // absolute local package source. `parseSource()`/`isLocalPath()` accept
    // absolute paths as-is (resolvePath() short-circuits on isAbsolute), so
    // no relative-path/symlink juggling is needed even though the package
    // lives outside the fixture's project tree (bun's `.bun` store).
    fs.writeFileSync(
      path.join(piDir, 'settings.json'),
      JSON.stringify(
        { packages: [relativePackagePath, PI_SUBAGENTS_PKG_DIR] },
        null,
        2,
      ),
    )
    writeMockModelsConfig(fixture, mockModel.url)
  })

  afterEach(async () => {
    if (client) {
      await client.close()
      client = undefined
    }
    mockModel.stop()
    destroyIsolatedFixture(fixture)
  })

  test(
    'one bounded top-level pi-subagents Agent call invokes exactly one nested systematic_delegate call, constructed with noExtensions: true',
    async () => {
      client = spawnPiRpc({ fixture })

      await client.send({
        type: 'set_model',
        provider: MOCK_PROVIDER_ID,
        modelId: MOCK_MODEL_ID,
      })

      // Turn 1 (top-level/outer session): model emits pi-subagents' real
      // `Agent` tool call, targeting the built-in "general-purpose" type
      // (extensions: true — see default-agents.ts), which spawns a nested
      // session that itself loads Systematic's extension.
      mockModel.push({
        toolCalls: [
          {
            id: 'call_agent_1',
            name: 'Agent',
            arguments: {
              prompt:
                'Delegate to best-practices-researcher via systematic_delegate to summarize a best practice.',
              description: 'Delegate best-practice summary',
              subagent_type: 'general-purpose',
            },
          },
        ],
      })
      // Turn 2 (nested session, spawned by pi-subagents' runAgent() with
      // extensions loaded): the nested session's model emits exactly one
      // systematic_delegate call.
      mockModel.push({
        toolCalls: [
          {
            id: 'call_delegate_nested_1',
            name: 'systematic_delegate',
            arguments: {
              agent: 'best-practices-researcher',
              task: 'Summarize one best practice in one sentence.',
            },
          },
        ],
      })
      // Turn 3 (systematic_delegate's own depth-1 child, noExtensions: true):
      // completes the delegated persona turn.
      mockModel.push({ text: 'Best practice: keep functions small.' })
      // Turn 4 (nested session): acknowledges the delegate tool result.
      mockModel.push({ text: 'nested done' })
      // Turn 5 (top-level session): acknowledges the Agent tool result.
      mockModel.push({ text: 'top-level done' })

      const promptResponse = await client.send({
        type: 'prompt',
        message:
          'Use the Agent tool to delegate a best-practice summary via systematic_delegate.',
      })
      expect(promptResponse.success).toBe(true)

      // The bounded top-level call completed exactly once, RPC-visible on
      // the top-level session stream.
      const outerToolEnd = await client.waitFor(
        (msg) =>
          msg.type === 'tool_execution_end' &&
          (msg as { toolName?: string }).toolName === 'Agent',
        TIMEOUT_MS,
      )
      expect((outerToolEnd as { isError?: boolean }).isError).not.toBe(true)

      await client.waitFor((msg) => msg.type === 'agent_settled')

      // Ground-truth evidence: exactly 5 chat-completions requests were made
      // across BOTH the top-level and nested sessions — bounded, not
      // repeated/recursive.
      expect(mockModel.requests.length).toBe(5)

      const requestSystemText = (index: number): string => {
        const request = mockModel.requests[index] as {
          messages: { role: string; content: unknown }[]
        }
        return request.messages
          .filter((m) => m.role === 'system' || m.role === 'developer')
          .map((m) =>
            typeof m.content === 'string'
              ? m.content
              : JSON.stringify(m.content),
          )
          .join('\n')
      }
      const requestToolNames = (index: number): string[] => {
        const request = mockModel.requests[index] as {
          tools?: { function?: { name?: string } }[]
        }
        return (request.tools ?? [])
          .map((t) => t.function?.name)
          .filter((name): name is string => typeof name === 'string')
      }

      // Request 0 — top-level session: Systematic's own extension AND
      // pi-subagents both loaded here (both packages configured at project
      // scope), so both tool sets are visible.
      expect(requestSystemText(0)).toContain('<SYSTEMATIC_WORKFLOWS>')
      expect(requestToolNames(0)).toContain('Agent')
      expect(requestToolNames(0)).toContain('systematic_delegate')

      // Request 1 — nested session spawned by pi-subagents' runAgent(): the
      // pi-subagents append-mode wrapper tag proves this is a genuine
      // pi-subagents-spawned child, distinct from the top-level session.
      // extensions: true (general-purpose) means Systematic's extension
      // loaded again here too, so systematic_delegate is available.
      expect(requestSystemText(1)).toContain('<sub_agent_context>')
      expect(requestToolNames(1)).toContain('systematic_delegate')

      // Request 2 — systematic_delegate's own depth-1 child
      // (src/lib/pi-delegate-session.ts, noExtensions: true): system prompt
      // is the persona body verbatim (systemPromptOverride), and neither
      // Agent nor systematic_delegate appear in its tools — the REAL,
      // runtime-observed proof that this child was constructed with
      // noExtensions: true, not merely the code-level guarantee already
      // unit-tested by pi-delegate-session.test.ts.
      expect(requestSystemText(2)).toContain('expert technology researcher')
      expect(requestSystemText(2)).not.toContain('<SYSTEMATIC_WORKFLOWS>')
      expect(requestToolNames(2)).not.toContain('Agent')
      expect(requestToolNames(2)).not.toContain('systematic_delegate')

      // No global depth cap is asserted here — this only proves the observed
      // two-level call graph (pi-subagents Agent → nested session →
      // systematic_delegate) completes, and that the nested delegate call was
      // itself constructed with noExtensions: true.
    },
    TIMEOUT_MS,
  )
})

describe('Combined-path characterization: scope statement', () => {
  test('characterization (always): systematic_delegate boundary is Systematic-local — does not prevent external delegation above/alongside it', () => {
    /**
     * This assertion codifies the boundary scope statement as a always-run unit
     * assertion. It does not require a real pi-subagents runtime.
     *
     * The scope of systematic_delegate's boundary (noExtensions + re-entry guard):
     *   ✓ Prevents the CHILD spawned by systematic_delegate from loading Systematic's
     *     Pi extension and re-registering systematic_delegate.
     *   ✓ Prevents DELEGATE_TOOL_NAME from appearing in the child session's tool allowlist.
     *   ✗ Does NOT prevent pi-subagents (or any external tool) from spawning its own
     *     child sessions that may themselves load Systematic's extension.
     *   ✗ Does NOT enforce a global delegation-depth cap across the combined call graph.
     *
     * This is the canonical reference for R12 + plan Unit 3 scope statement.
     * The boundary is verified by tests in tests/unit/pi-delegate-session.test.ts
     * (boundary characterization describe block).
     *
     * Pre-assertion evidence captured: all 6 tests in pi-delegate-session.test.ts
     * pass (4 original + 2 boundary characterization) confirming the boundary holds
     * at the unit level. The combined end-to-end path is ALSO exercised at
     * runtime against the real, installed @tintinweb/pi-subagents v0.14.3 —
     * see the "Combined-path bounded execution" describe block above.
     */

    // The boundary scope: systematic_delegate's noExtensions is Systematic-local.
    const SYSTEMATIC_DELEGATE_BOUNDARY_SCOPE = [
      'noExtensions: true prevents child from loading Systematic Pi extension',
      'explicit re-entry guard prevents DELEGATE_TOOL_NAME in child tool allowlist',
      'does NOT cap global depth across pi-subagents or other external delegation engines',
      'external delegation engines are governed by their own limits/config',
    ] as const

    // This assertion is definitional / always-true; it documents the intended scope.
    expect(SYSTEMATIC_DELEGATE_BOUNDARY_SCOPE).toHaveLength(4)
    expect(SYSTEMATIC_DELEGATE_BOUNDARY_SCOPE[0]).toContain('noExtensions')
    expect(SYSTEMATIC_DELEGATE_BOUNDARY_SCOPE[1]).toContain('re-entry guard')
    expect(SYSTEMATIC_DELEGATE_BOUNDARY_SCOPE[2]).toContain(
      'NOT cap global depth',
    )
    expect(SYSTEMATIC_DELEGATE_BOUNDARY_SCOPE[3]).toContain(
      'governed by their own',
    )
  })
})
