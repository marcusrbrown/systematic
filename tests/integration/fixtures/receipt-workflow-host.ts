import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const OPENCODE_AVAILABLE = (() => {
  const result = Bun.spawnSync(['which', 'opencode'])
  return result.exitCode === 0
})()

export const TIMEOUT_MS = 90_000
export const MAX_RETRIES = 1
export const RETRY_DELAY_MS = 3_000
export const OPENCODE_TEST_MODEL = 'opencode/big-pickle'
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

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
  return { ...base, ...overrides }
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

export interface RunOpencodeOptions {
  fixture: IsolatedFixture
  configContent: string
  extraEnv?: Record<string, string>
}

export async function runOpencode(
  prompt: string,
  options: RunOpencodeOptions,
): Promise<OpencodeResult> {
  const { fixture, configContent, extraEnv } = options
  const childEnv = buildIsolatedOpencodeEnv(fixture, configContent, extraEnv)
  let lastResult: OpencodeResult = { stdout: '', stderr: '', exitCode: -1 }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = Bun.spawnSync(
      ['opencode', 'run', '--model', OPENCODE_TEST_MODEL, prompt],
      {
        cwd: fixture.projectDir,
        env: childEnv,
        timeout: TIMEOUT_MS,
      },
    )

    lastResult = {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode ?? -1,
    }

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  if (countWorkflowBlocks(system) !== 1) {
    throw new Error('mixed-version probe observed duplicate workflow blocks')
  }
  if (!system[0]?.includes('<SYSTEMATIC_WORKFLOWS>')) {
    throw new Error('workflow block was not first system entry')
  }
  for (const [index, entry] of system.entries()) {
    if (index > 0 && entry.includes('<SYSTEMATIC_WORKFLOWS>')) {
      throw new Error('workflow block appeared in a later system entry')
    }
  }
  if (!system[0]?.includes('<available_skills>')) {
    throw new Error('workflow system block omitted available skills')
  }
  if (!/ce:brainstorm|systematic:git-clean-gone-branches/.test(system[0])) {
    throw new Error('workflow system block omitted expected skill names')
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
): Promise<OpencodeServer> {
  const server = spawn(command, [...args], {
    env,
    cwd: fixture.projectDir,
  })
  const pid = server.pid
  if (!pid) throw new Error('opencode server did not expose a process id')

  const url = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    const timeout = setTimeout(() => {
      server.kill('SIGTERM')
      reject(
        new Error(`OpenCode server start timed out: ${buffer.slice(-500)}`),
      )
    }, TIMEOUT_MS)

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
  return {
    url,
    pid,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      await stopOpencodeProcess(server)
    },
  }
}

export async function startOpencodeServer(
  fixture: IsolatedFixture,
  configContent: string,
  extraEnv?: Record<string, string>,
): Promise<OpencodeServer> {
  return startOpencodeProcess(
    fixture,
    'opencode',
    ['serve', '--port', '0', '--print-logs'],
    buildIsolatedOpencodeEnv(fixture, configContent, extraEnv),
  )
}

export async function startExactOpencodeServer(
  fixture: IsolatedFixture,
  configContent: string,
  version: string,
  extraEnv?: Record<string, string>,
): Promise<OpencodeServer> {
  return startOpencodeProcess(
    fixture,
    'npx',
    ['--yes', `opencode-ai@${version}`, 'serve', '--port', '0', '--print-logs'],
    buildIsolatedOpencodeEnv(fixture, configContent, {
      NPM_CONFIG_CACHE: path.join(fixture.tempRoot, 'npm-cache'),
      npm_config_update_notifier: 'false',
      ...extraEnv,
    }),
  )
}

export interface OpencodeServer {
  url: string
  pid: number
  stop(): Promise<void>
}

async function stopOpencodeProcess(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      server.kill('SIGKILL')
      resolve()
    }, 10_000)
    server.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    server.kill('SIGTERM')
  })
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
