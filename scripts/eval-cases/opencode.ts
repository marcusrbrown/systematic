import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'

import {
  buildEvalChildEnv,
  type EvalCaseExecution,
  type EvalCaseManifest,
  type EvalFixture,
  EXPECTED_OPENCODE_VERSION,
  type HostCatalogCoverageObservation,
  type PromptCompositionObservation,
} from '../run-evals.ts'

const MODEL_PROVIDER_ID = 'systematic-eval-local-provider'
const MODEL_ID = 'systematic-eval-local-model'
const EXPECTED_WRITE_CONTENT = 'fixture-local-write-v1'
const PROBE_FAKE_VALUE_MARKER = 'eval-parent-fake-value'
const PROBE_DIGEST = createHash('sha256')
  .update('systematic-eval-probe-v3')
  .digest('hex')

const BOOTSTRAP_MARKER_OPEN = '<SYSTEMATIC_WORKFLOWS>'
const BOOTSTRAP_MARKER_CLOSE = '</SYSTEMATIC_WORKFLOWS>'
const CATALOG_MARKER_OPEN = '<available_skills>'
const CATALOG_MARKER_CLOSE = '</available_skills>'
const OPENCODE_HOST_TIMEOUT = 'opencode-host-timeout'
const OPENCODE_PROMPT_TIMEOUT = 'opencode-prompt-timeout'
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/
const MAX_BOOTSTRAP_PAYLOAD_SIZE = 100_000
const MAX_CATALOG_ENTRIES = 128

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
  stop(): Promise<void>
}

export type BoundedProbeEvent =
  | { type: 'loaded'; status: 'ok' | 'unhealthy' }
  | {
      type: 'transform'
      kind: 'chat'
      status: 'healthy' | 'unhealthy'
      blockCount: number
      promptComposition?: PromptCompositionObservation
    }
  | { type: 'tool'; tool: 'write'; outcome: 'success' | 'failure' }

export interface OpencodeProbe {
  url: string
  capturePath: string
  sourcePath: string
  digest: string
}

interface ProbeHealth {
  status: 'healthy' | 'unhealthy'
  subcode?: 'probe_unhealthy'
  blockCount?: number
  transformCount?: number
  promptComposition: PromptCompositionObservation
}

interface FixtureWriteGrade {
  outcome: 'success' | 'task_failure' | 'infra_failure'
  subcode: 'none' | 'write_missing' | 'write_mismatch' | 'path_escape'
}

interface OpencodeHost {
  url: string
  stop(): Promise<void>
}

interface StoppableModelServer {
  stop(closeActiveConnections?: boolean): void
}

const activeOpencodeChildren = new Set<ChildProcess>()
const activeModelServers = new Set<StoppableModelServer>()

function impossiblePromptComposition(): PromptCompositionObservation {
  return {
    bootstrapPayloadSize: 0,
    systematicCatalog: {
      state: 'impossible',
      entryCount: 0,
      skillNames: [],
    },
    hostCatalog: {
      state: 'impossible',
      entryCount: 0,
      skillNames: [],
    },
  }
}

function findCompleteBlocks(
  text: string,
  open: string,
  close: string,
): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf(open, cursor)
    if (start === -1) break
    const closeStart = text.indexOf(close, start + open.length)
    if (closeStart === -1) break
    blocks.push({ start, end: closeStart + close.length })
    cursor = closeStart + close.length
  }
  return blocks
}

function findWorkflowBlocks(text: string): {
  valid: boolean
  blocks: Array<{ start: number; end: number }>
} {
  const blocks: Array<{ start: number; end: number }> = []
  let openStart = -1
  let openCount = 0
  let closeCount = 0
  let cursor = 0

  while (cursor < text.length) {
    const openStartCandidate = text.indexOf(BOOTSTRAP_MARKER_OPEN, cursor)
    const closeStartCandidate = text.indexOf(BOOTSTRAP_MARKER_CLOSE, cursor)
    if (openStartCandidate === -1 && closeStartCandidate === -1) break

    if (
      closeStartCandidate === -1 ||
      (openStartCandidate !== -1 && openStartCandidate < closeStartCandidate)
    ) {
      openCount += 1
      if (openStart !== -1) return { valid: false, blocks: [] }
      openStart = openStartCandidate
      cursor = openStartCandidate + BOOTSTRAP_MARKER_OPEN.length
      continue
    }

    closeCount += 1
    if (openStart === -1) return { valid: false, blocks: [] }
    blocks.push({
      start: openStart,
      end: closeStartCandidate + BOOTSTRAP_MARKER_CLOSE.length,
    })
    openStart = -1
    cursor = closeStartCandidate + BOOTSTRAP_MARKER_CLOSE.length
  }

  if (openStart !== -1 || openCount !== closeCount) {
    return { valid: false, blocks: [] }
  }
  return { valid: true, blocks }
}

export function observePromptComposition(
  system: readonly unknown[],
): PromptCompositionObservation {
  if (!system.every((entry) => typeof entry === 'string')) {
    return impossiblePromptComposition()
  }

  const text = system.join('\n\n')
  const workflowStructure = findWorkflowBlocks(text)
  if (!workflowStructure.valid) return impossiblePromptComposition()
  const workflowBlocks = workflowStructure.blocks
  const catalogBlocks = findCompleteBlocks(
    text,
    CATALOG_MARKER_OPEN,
    CATALOG_MARKER_CLOSE,
  )
  const systematicBlocks = catalogBlocks.filter((block) =>
    workflowBlocks.some(
      (workflow) => block.start >= workflow.start && block.end <= workflow.end,
    ),
  )
  const systematicBlockTexts = new Set(
    systematicBlocks.map((block) => text.slice(block.start, block.end)),
  )
  const hostBlocks = catalogBlocks.filter(
    (block) =>
      !workflowBlocks.some(
        (workflow) =>
          block.start >= workflow.start && block.end <= workflow.end,
      ) && !systematicBlockTexts.has(text.slice(block.start, block.end)),
  )
  const summarize = (
    blocks: readonly { start: number; end: number }[],
  ): PromptCompositionObservation['systematicCatalog'] => {
    const names = new Set<string>()
    let entryCount = 0
    for (const block of blocks) {
      const catalogText = text.slice(block.start, block.end)
      for (const skillBlock of catalogText.matchAll(
        /<skill>([\s\S]*?)<\/skill>/g,
      )) {
        const name = skillBlock[1]
          ?.match(/<name>\s*([^<]+?)\s*<\/name>/)?.[1]
          ?.trim()
        if (!name || !SAFE_SKILL_NAME.test(name)) continue
        entryCount += 1
        names.add(name)
      }
    }
    return {
      state: blocks.length > 0 ? 'present' : 'absent',
      entryCount,
      skillNames: [...names].sort(),
    }
  }

  return {
    bootstrapPayloadSize: workflowBlocks.reduce(
      (size, block) => size + (block.end - block.start),
      0,
    ),
    systematicCatalog: summarize(systematicBlocks),
    hostCatalog: summarize(hostBlocks),
  }
}

function isBoundedCatalogObservation(
  value: unknown,
): value is PromptCompositionObservation['systematicCatalog'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (
    Object.keys(candidate).length !== 3 ||
    (candidate.state !== 'present' &&
      candidate.state !== 'absent' &&
      candidate.state !== 'impossible') ||
    typeof candidate.entryCount !== 'number' ||
    !Number.isInteger(candidate.entryCount) ||
    candidate.entryCount < 0 ||
    candidate.entryCount > MAX_CATALOG_ENTRIES ||
    !Array.isArray(candidate.skillNames) ||
    candidate.skillNames.length > MAX_CATALOG_ENTRIES
  ) {
    return false
  }
  const names = candidate.skillNames
  if (
    names.some(
      (name) =>
        typeof name !== 'string' ||
        !SAFE_SKILL_NAME.test(name) ||
        name.length > 128,
    )
  ) {
    return false
  }
  if (new Set(names).size !== names.length) return false
  if (candidate.state !== 'present') {
    return candidate.entryCount === 0 && names.length === 0
  }
  return names.length <= candidate.entryCount
}

function isBoundedPromptComposition(
  value: unknown,
): value is PromptCompositionObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    Object.keys(candidate).length === 3 &&
    typeof candidate.bootstrapPayloadSize === 'number' &&
    Number.isInteger(candidate.bootstrapPayloadSize) &&
    candidate.bootstrapPayloadSize >= 0 &&
    candidate.bootstrapPayloadSize <= MAX_BOOTSTRAP_PAYLOAD_SIZE &&
    isBoundedCatalogObservation(candidate.systematicCatalog) &&
    isBoundedCatalogObservation(candidate.hostCatalog)
  )
}

function isBoundedProbeEvent(value: unknown): value is BoundedProbeEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.type === 'loaded') {
    return (
      Object.keys(candidate).length === 2 &&
      (candidate.status === 'ok' || candidate.status === 'unhealthy')
    )
  }
  if (candidate.type === 'transform') {
    const hasPromptComposition = candidate.promptComposition !== undefined
    return (
      Object.keys(candidate).length === (hasPromptComposition ? 5 : 4) &&
      candidate.kind === 'chat' &&
      (candidate.status === 'healthy' || candidate.status === 'unhealthy') &&
      typeof candidate.blockCount === 'number' &&
      Number.isInteger(candidate.blockCount) &&
      candidate.blockCount >= 0 &&
      candidate.blockCount <= 8 &&
      (candidate.status !== 'healthy' ||
        isBoundedPromptComposition(candidate.promptComposition)) &&
      (candidate.promptComposition === undefined ||
        isBoundedPromptComposition(candidate.promptComposition))
    )
  }
  return (
    candidate.type === 'tool' &&
    Object.keys(candidate).length === 3 &&
    candidate.tool === 'write' &&
    (candidate.outcome === 'success' || candidate.outcome === 'failure')
  )
}

export function readBoundedProbeEvents(
  capturePath: string,
): BoundedProbeEvent[] {
  if (!fs.existsSync(capturePath)) return []
  const content = fs.readFileSync(capturePath, 'utf8').trim()
  if (content === '') return []
  const events: BoundedProbeEvent[] = []
  for (const line of content.split('\n')) {
    try {
      const parsed = JSON.parse(line) as unknown
      if (!isBoundedProbeEvent(parsed)) return []
      events.push(parsed)
    } catch {
      return []
    }
  }
  return events
}

export function createOpencodeProbe(fixture: EvalFixture): OpencodeProbe {
  const sourcePath = path.join(fixture.probeRoot, 'index.mjs')
  const packagePath = path.join(fixture.probeRoot, 'package.json')
  const capturePath = path.join(fixture.probeRoot, 'events.jsonl')
  fs.writeFileSync(
    packagePath,
    JSON.stringify({
      name: 'systematic-eval-probe',
      type: 'module',
      main: './index.mjs',
    }),
  )
  fs.writeFileSync(
    sourcePath,
    `import fs from 'node:fs'

const capturePath = ${JSON.stringify(capturePath)}
const expectedHome = ${JSON.stringify(fixture.homeRoot)}
const expectedConfig = ${JSON.stringify(fixture.opencodeConfigRoot)}
const fakeValueMarker = ${JSON.stringify(PROBE_FAKE_VALUE_MARKER)}
const forbiddenNames = ${JSON.stringify([
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'NPM_TOKEN',
      'OPENAI_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'SSH_AUTH_SOCK',
      'GIT_ASKPASS',
      'OPENCODE_AUTH_TOKEN',
    ])}

function append(event) {
  fs.appendFileSync(capturePath, JSON.stringify(event) + '\\n')
}

function workflowBlockCount(system) {
  return system.reduce((count, entry) =>
    count + (typeof entry === 'string' ? entry.split('<SYSTEMATIC_WORKFLOWS>').length - 1 : 0), 0)
}

const bootstrapMarkerOpen = '<SYSTEMATIC_WORKFLOWS>'
const bootstrapMarkerClose = '</SYSTEMATIC_WORKFLOWS>'
const catalogMarkerOpen = '<available_skills>'
const catalogMarkerClose = '</available_skills>'
const safeSkillName = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/

function impossiblePromptComposition() {
  return {
    bootstrapPayloadSize: 0,
    systematicCatalog: { state: 'impossible', entryCount: 0, skillNames: [] },
    hostCatalog: { state: 'impossible', entryCount: 0, skillNames: [] },
  }
}

function findCompleteBlocks(text, open, close) {
  const blocks = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf(open, cursor)
    if (start === -1) break
    const closeStart = text.indexOf(close, start + open.length)
    if (closeStart === -1) break
    blocks.push({ start, end: closeStart + close.length })
    cursor = closeStart + close.length
  }
  return blocks
}

function findWorkflowBlocks(text) {
  const blocks = []
  let openStart = -1
  let openCount = 0
  let closeCount = 0
  let cursor = 0
  while (cursor < text.length) {
    const openStartCandidate = text.indexOf(bootstrapMarkerOpen, cursor)
    const closeStartCandidate = text.indexOf(bootstrapMarkerClose, cursor)
    if (openStartCandidate === -1 && closeStartCandidate === -1) break
    if (
      closeStartCandidate === -1 ||
      (openStartCandidate !== -1 && openStartCandidate < closeStartCandidate)
    ) {
      openCount += 1
      if (openStart !== -1) return { valid: false, blocks: [] }
      openStart = openStartCandidate
      cursor = openStartCandidate + bootstrapMarkerOpen.length
      continue
    }
    closeCount += 1
    if (openStart === -1) return { valid: false, blocks: [] }
    blocks.push({
      start: openStart,
      end: closeStartCandidate + bootstrapMarkerClose.length,
    })
    openStart = -1
    cursor = closeStartCandidate + bootstrapMarkerClose.length
  }
  if (openStart !== -1 || openCount !== closeCount) {
    return { valid: false, blocks: [] }
  }
  return { valid: true, blocks }
}

function summarizeCatalog(text, blocks) {
  const names = new Set()
  let entryCount = 0
  for (const block of blocks) {
    const catalogText = text.slice(block.start, block.end)
    for (const skillBlock of catalogText.matchAll(/<skill>([\\s\\S]*?)<\\/skill>/g)) {
      const name = skillBlock[1]?.match(/<name>\\s*([^<]+?)\\s*<\\/name>/)?.[1]?.trim()
      if (!name || !safeSkillName.test(name)) continue
      entryCount += 1
      names.add(name)
    }
  }
  return {
    state: blocks.length > 0 ? 'present' : 'absent',
    entryCount,
    skillNames: [...names].sort(),
  }
}

function observePromptComposition(system) {
  if (!system.every((entry) => typeof entry === 'string')) {
    return impossiblePromptComposition()
  }
  const text = system.join('\\n\\n')
  const workflowStructure = findWorkflowBlocks(text)
  if (!workflowStructure.valid) return impossiblePromptComposition()
  const workflowBlocks = workflowStructure.blocks
  const catalogBlocks = findCompleteBlocks(text, catalogMarkerOpen, catalogMarkerClose)
  const systematicBlocks = catalogBlocks.filter((block) => workflowBlocks.some((workflow) => block.start >= workflow.start && block.end <= workflow.end))
  const systematicBlockTexts = new Set(systematicBlocks.map((block) => text.slice(block.start, block.end)))
  const hostBlocks = catalogBlocks.filter((block) =>
    !workflowBlocks.some((workflow) => block.start >= workflow.start && block.end <= workflow.end) &&
    !systematicBlockTexts.has(text.slice(block.start, block.end)))
  return {
    bootstrapPayloadSize: workflowBlocks.reduce((size, block) => size + block.end - block.start, 0),
    systematicCatalog: summarizeCatalog(text, systematicBlocks),
    hostCatalog: summarizeCatalog(text, hostBlocks),
  }
}

export { observePromptComposition }

function isChatTransform(input) {
  return Boolean(input && typeof input === 'object' && typeof input.sessionID === 'string' && 'model' in input)
}

export default async function systematicEvalProbe() {
  const forbiddenNamePresent = forbiddenNames.some((name) => Object.hasOwn(process.env, name))
  const forbiddenValuePresent = Object.values(process.env).includes(fakeValueMarker)
  const controlledRootsPresent = process.env.HOME === expectedHome && process.env.OPENCODE_CONFIG_DIR === expectedConfig
  append({ type: 'loaded', status: forbiddenNamePresent || forbiddenValuePresent || !controlledRootsPresent ? 'unhealthy' : 'ok' })
  return {
    'experimental.chat.system.transform': async (input, output) => {
      if (!isChatTransform(input)) return
      const systemVisible = Array.isArray(output?.system)
      const system = systemVisible ? output.system : []
      const blockCount = workflowBlockCount(system)
      const promptComposition = systemVisible
        ? observePromptComposition(system)
        : impossiblePromptComposition()
      append({ type: 'transform', kind: 'chat', status: systemVisible ? 'healthy' : 'unhealthy', blockCount, promptComposition })
    },
    'tool.execute.after': async (input, output) => {
      if (input.tool !== 'write') return
      const failed = Boolean(output && typeof output === 'object' && Object.hasOwn(output, 'error'))
      append({ type: 'tool', tool: 'write', outcome: failed ? 'failure' : 'success' })
    },
  }
}
`,
  )
  return {
    url: pathToFileURL(fixture.probeRoot).href,
    capturePath,
    sourcePath,
    digest: PROBE_DIGEST,
  }
}

export function gradeBootstrapProbe(
  events: readonly BoundedProbeEvent[],
): ProbeHealth {
  const loaded = events.filter((event) => event.type === 'loaded')
  const transforms = events.filter((event) => event.type === 'transform')
  const promptComposition =
    transforms.at(-1)?.promptComposition ?? impossiblePromptComposition()
  if (
    loaded.length !== 1 ||
    loaded[0]?.status !== 'ok' ||
    transforms.length === 0 ||
    transforms.some(
      (event) =>
        event.status !== 'healthy' ||
        event.blockCount !== 1 ||
        event.promptComposition === undefined ||
        event.promptComposition.systematicCatalog.state === 'impossible' ||
        event.promptComposition.hostCatalog.state === 'impossible',
    )
  ) {
    return {
      status: 'unhealthy',
      subcode: 'probe_unhealthy',
      promptComposition,
    }
  }
  return {
    status: 'healthy',
    blockCount: 1,
    transformCount: transforms.length,
    promptComposition,
  }
}

export interface HostSkillCoverageGrade {
  outcome: 'success' | 'infra_failure' | 'task_failure'
  subcode:
    | 'none'
    | 'probe_unhealthy'
    | 'host_catalog_absent'
    | 'host_catalog_incomplete'
  promptComposition: PromptCompositionObservation
  hostCatalogCoverage: HostCatalogCoverageObservation
}

export function gradeHostSkillCoverage(
  events: readonly BoundedProbeEvent[],
  expectedSkillNames: readonly string[],
): HostSkillCoverageGrade {
  const expected = [...expectedSkillNames].sort()
  const transforms = events.filter((event) => event.type === 'transform')
  const promptComposition =
    transforms.at(-1)?.promptComposition ?? impossiblePromptComposition()
  const impossibleCoverage: HostCatalogCoverageObservation = {
    state: 'impossible',
    expectedSkillNames: expected,
    observedSkillNames: [],
    missingSkillNames: [],
  }
  const loaded = events.filter((event) => event.type === 'loaded')
  const probeHealthy =
    loaded.length === 1 &&
    loaded[0]?.status === 'ok' &&
    transforms.length > 0 &&
    transforms.every(
      (event) =>
        event.status === 'healthy' &&
        event.blockCount === 1 &&
        event.promptComposition !== undefined &&
        event.promptComposition.systematicCatalog.state !== 'impossible' &&
        event.promptComposition.hostCatalog.state !== 'impossible',
    )

  if (!probeHealthy || promptComposition.hostCatalog.state === 'impossible') {
    return {
      outcome: 'infra_failure',
      subcode: 'probe_unhealthy',
      promptComposition,
      hostCatalogCoverage: impossibleCoverage,
    }
  }

  const observed = promptComposition.hostCatalog.skillNames
  const missing = expected.filter((name) => !observed.includes(name))
  const hostCatalogCoverage: HostCatalogCoverageObservation = {
    state: promptComposition.hostCatalog.state,
    expectedSkillNames: expected,
    observedSkillNames: observed,
    missingSkillNames: missing,
  }

  if (promptComposition.hostCatalog.state === 'absent') {
    return {
      outcome: 'task_failure',
      subcode: 'host_catalog_absent',
      promptComposition,
      hostCatalogCoverage: {
        ...hostCatalogCoverage,
        missingSkillNames: expected,
      },
    }
  }
  if (missing.length > 0) {
    return {
      outcome: 'task_failure',
      subcode: 'host_catalog_incomplete',
      promptComposition,
      hostCatalogCoverage,
    }
  }
  return {
    outcome: 'success',
    subcode: 'none',
    promptComposition,
    hostCatalogCoverage,
  }
}

function canonicalPath(value: string): string {
  let current = path.resolve(value)
  const suffix: string[] = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(current, ...suffix)
    suffix.unshift(path.basename(current))
    current = parent
  }
  return path.resolve(fs.realpathSync(current), ...suffix)
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

export function gradeFixtureWrite(
  projectRoot: string,
  expected: Pick<
    Extract<EvalCaseManifest, { caseId: 'fixture-local-write' }>,
    'expectedArtifactId' | 'expectedContentId'
  >,
): FixtureWriteGrade {
  const root = canonicalPath(projectRoot)
  const target = canonicalPath(
    path.resolve(projectRoot, expected.expectedArtifactId),
  )
  if (!isWithin(root, target)) {
    return { outcome: 'infra_failure', subcode: 'path_escape' }
  }
  if (!fs.existsSync(target)) {
    return { outcome: 'task_failure', subcode: 'write_missing' }
  }
  if (expected.expectedContentId !== EXPECTED_WRITE_CONTENT) {
    return { outcome: 'task_failure', subcode: 'write_mismatch' }
  }
  try {
    const content = fs.readFileSync(target, 'utf8')
    return content === EXPECTED_WRITE_CONTENT
      ? { outcome: 'success', subcode: 'none' }
      : { outcome: 'task_failure', subcode: 'write_mismatch' }
  } catch {
    return { outcome: 'task_failure', subcode: 'write_missing' }
  }
}

function sseChunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function responseChunks(
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
        model: MODEL_ID,
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
        model: MODEL_ID,
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
      model: MODEL_ID,
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
            model: MODEL_ID,
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
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ]
}

export function startScriptedModelServer(
  responses: readonly ScriptedResponse[],
): ScriptedModelServer {
  let requestIndex = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        !request.url.endsWith('/chat/completions')
      ) {
        return new Response('not found', { status: 404 })
      }
      await request.json()
      const response = responses[requestIndex] ?? { text: '' }
      requestIndex += 1
      const chunks = responseChunks(
        response,
        `systematic-eval-${requestIndex}`,
        Math.floor(Date.now() / 1000),
      )
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
  activeModelServers.add(server)
  let stopped = false
  return {
    url: `http://localhost:${server.port}/v1`,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      activeModelServers.delete(server)
      server.stop(true)
    },
  }
}

function buildProviderConfig(
  pluginUrls: readonly string[],
  baseUrl: string,
): string {
  return JSON.stringify({
    formatter: false,
    lsp: false,
    plugin: pluginUrls,
    provider: {
      [MODEL_PROVIDER_ID]: {
        name: 'Systematic Eval Local Provider',
        id: MODEL_PROVIDER_ID,
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [MODEL_ID]: {
            id: MODEL_ID,
            name: 'Systematic Eval Local Model',
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: '2026-08-13',
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: 'local-eval-only', baseURL: baseUrl },
      },
    },
  })
}

function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

async function startOpencodeHost(
  fixture: EvalFixture,
  configContent: string,
  modelBaseUrl: string,
  parentEnv: Readonly<Record<string, string | undefined>> | undefined,
  timeoutMs: number,
): Promise<OpencodeHost> {
  const child = spawn(
    'npx',
    [
      '--yes',
      `opencode-ai@${EXPECTED_OPENCODE_VERSION}`,
      'serve',
      '--port',
      '0',
      '--print-logs',
    ],
    {
      cwd: fixture.projectRoot,
      env: buildEvalChildEnv({
        fixture,
        configContent,
        modelBaseUrl,
        parentEnv,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  activeOpencodeChildren.add(child)
  child.once('exit', () => activeOpencodeChildren.delete(child))
  const markerPath = process.env.SYSTEMATIC_EVAL_STARTED_CHILD_MARKER
  if (markerPath) {
    try {
      fs.writeFileSync(markerPath, 'started\n')
    } catch {
      // The marker is test-only evidence and must not affect execution.
    }
  }
  const url = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      void stopChildProcess(child)
      reject(new Error(OPENCODE_HOST_TIMEOUT))
    }, timeoutMs)
    const onChunk = (chunk: Buffer): void => {
      if (settled) return
      buffer = `${buffer}${chunk.toString()}`.slice(-4096)
      const match = buffer.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/)
      if (!match) return
      settled = true
      clearTimeout(timeout)
      resolve(match[0])
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.once('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error('opencode-host-unavailable'))
    })
    child.once('exit', (code) => {
      if (settled || code === 0) return
      settled = true
      clearTimeout(timeout)
      reject(new Error('opencode-host-exited'))
    })
  })
  let stopped = false
  return {
    url,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      await stopChildProcess(child)
    },
  }
}

export async function stopActiveEvalResources(): Promise<void> {
  const children = [...activeOpencodeChildren]
  await Promise.all(
    children.map(async (child) => {
      await stopChildProcess(child)
      activeOpencodeChildren.delete(child)
    }),
  )
  for (const server of [...activeModelServers]) {
    try {
      server.stop(true)
    } catch {
      // Cleanup is best effort; the caller owns the bounded force-exit guard.
    }
    activeModelServers.delete(server)
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(OPENCODE_PROMPT_TIMEOUT)),
      timeoutMs,
    )
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      () => {
        clearTimeout(timeout)
        reject(new Error('opencode-prompt-failed'))
      },
    )
  })
}

export function executionFailure(
  subcode: 'opencode_unavailable' | 'probe_unhealthy' | 'unexpected_exit',
  probeDigest: string,
  promptComposition = impossiblePromptComposition(),
): EvalCaseExecution {
  return {
    outcome: subcode === 'unexpected_exit' ? 'task_failure' : 'infra_failure',
    subcode,
    sanity: 'failed',
    process: 'failed',
    probeDigest,
    artifactRefs: ['probe/events.jsonl'],
    promptComposition,
  }
}

function isKnownTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === OPENCODE_HOST_TIMEOUT ||
      error.message === OPENCODE_PROMPT_TIMEOUT)
  )
}

export function classifyExecutionFailure(
  hostStarted: boolean,
  error: unknown,
  events: readonly BoundedProbeEvent[],
  probeDigest: string,
): EvalCaseExecution {
  const probeHealth = gradeBootstrapProbe(events)
  if (hostStarted && isKnownTimeoutError(error)) {
    return executionFailure(
      'unexpected_exit',
      probeDigest,
      probeHealth.promptComposition,
    )
  }
  if (hostStarted && probeHealth.status !== 'healthy') {
    return executionFailure(
      'probe_unhealthy',
      probeDigest,
      probeHealth.promptComposition,
    )
  }
  return executionFailure(
    hostStarted ? 'unexpected_exit' : 'opencode_unavailable',
    probeDigest,
    probeHealth.promptComposition,
  )
}

interface ExecuteCaseInput {
  fixture: EvalFixture
  caseManifest: EvalCaseManifest
  pluginEntry: string
  parentEnv?: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
  caseTimeoutMs?: number
  artifactRefs?: readonly string[]
}

function isPromptOnlyCase(caseId: EvalCaseManifest['caseId']): boolean {
  return caseId === 'bootstrap-loading' || caseId === 'host-skill-coverage'
}

function buildScriptedResponses(
  caseId: EvalCaseManifest['caseId'],
): ScriptedResponse[] {
  if (isPromptOnlyCase(caseId)) return [{ text: 'done' }]
  return [
    {
      toolCalls: [
        {
          id: 'fixture-write-call',
          name: 'write',
          arguments: {
            filePath: 'fixture/output.txt',
            content: EXPECTED_WRITE_CONTENT,
          },
        },
      ],
    },
    { text: 'done' },
  ]
}

function gradeObservedCase(
  input: ExecuteCaseInput,
  events: readonly BoundedProbeEvent[],
  probeDigest: string,
  artifactRefs: string[],
): EvalCaseExecution {
  if (input.caseManifest.caseId === 'host-skill-coverage') {
    const coverageGrade = gradeHostSkillCoverage(
      events,
      input.caseManifest.expectedSkillNames,
    )
    const failed = coverageGrade.outcome === 'infra_failure'
    return {
      outcome: coverageGrade.outcome,
      subcode: coverageGrade.subcode,
      sanity: failed ? 'failed' : 'passed',
      process: failed ? 'failed' : 'completed',
      probeDigest,
      artifactRefs,
      promptComposition: coverageGrade.promptComposition,
      hostCatalogCoverage: coverageGrade.hostCatalogCoverage,
    }
  }

  const probeHealth = gradeBootstrapProbe(events)
  if (probeHealth.status !== 'healthy') {
    return executionFailure(
      'probe_unhealthy',
      probeDigest,
      probeHealth.promptComposition,
    )
  }
  if (input.caseManifest.caseId === 'bootstrap-loading') {
    return {
      outcome: 'success',
      subcode: 'none',
      sanity: 'passed',
      process: 'completed',
      probeDigest,
      artifactRefs,
      promptComposition: probeHealth.promptComposition,
    }
  }
  const writeGrade = gradeFixtureWrite(
    input.fixture.projectRoot,
    input.caseManifest,
  )
  return {
    outcome: writeGrade.outcome,
    subcode: writeGrade.subcode,
    sanity: 'passed',
    process: 'completed',
    probeDigest,
    artifactRefs,
    promptComposition: probeHealth.promptComposition,
  }
}

async function executeCase(
  input: ExecuteCaseInput,
): Promise<EvalCaseExecution> {
  const probe = createOpencodeProbe(input.fixture)
  const responses = buildScriptedResponses(input.caseManifest.caseId)
  const model = startScriptedModelServer(responses)
  let host: OpencodeHost | undefined
  const hostTimeoutMs = input.timeoutMs ?? 180_000
  const caseTimeoutMs = input.caseTimeoutMs ?? hostTimeoutMs
  const caseArtifactRefs = isPromptOnlyCase(input.caseManifest.caseId)
    ? ['probe/events.jsonl']
    : ['fixture/output.txt', 'probe/events.jsonl']
  const artifactRefs = [
    ...(input.artifactRefs ?? []),
    ...caseArtifactRefs,
  ].sort()

  try {
    const configContent = buildProviderConfig(
      [pathToFileURL(input.pluginEntry).href, probe.url],
      model.url,
    )
    fs.writeFileSync(input.fixture.opencodeConfigPath, configContent)
    host = await startOpencodeHost(
      input.fixture,
      configContent,
      model.url,
      input.parentEnv,
      hostTimeoutMs,
    )
    const client = createOpencodeClient({
      baseUrl: host.url,
      directory: input.fixture.projectRoot,
    })
    const session = await client.session.create({
      directory: input.fixture.projectRoot,
      title: `systematic eval ${input.caseManifest.caseId}`,
      permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    })
    await withTimeout(
      client.session.prompt({
        sessionID: session.data.id,
        directory: input.fixture.projectRoot,
        model: { providerID: MODEL_PROVIDER_ID, modelID: MODEL_ID },
        parts: [
          {
            type: 'text',
            text:
              input.caseManifest.caseId === 'bootstrap-loading'
                ? 'Complete the deterministic bootstrap probe.'
                : 'Create the deterministic fixture file using the built-in write tool.',
          },
        ],
      }),
      caseTimeoutMs,
    )

    return gradeObservedCase(
      input,
      readBoundedProbeEvents(probe.capturePath),
      probe.digest,
      artifactRefs,
    )
  } catch (error) {
    return classifyExecutionFailure(
      host !== undefined,
      error,
      readBoundedProbeEvents(probe.capturePath),
      probe.digest,
    )
  } finally {
    try {
      if (host) await host.stop()
    } catch {
      // Cleanup status is owned by the shared runner.
    }
    try {
      await model.stop()
    } catch {
      // Cleanup status is owned by the shared runner.
    }
  }
}

export function executeSourceCase(input: {
  fixture: EvalFixture
  caseManifest: EvalCaseManifest
  sourceEntry: string
  parentEnv?: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
  caseTimeoutMs?: number
}): Promise<EvalCaseExecution> {
  return executeCase({ ...input, pluginEntry: input.sourceEntry })
}

export function executeInstalledCase(input: {
  fixture: EvalFixture
  caseManifest: EvalCaseManifest
  installedEntry: string
  parentEnv?: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
  caseTimeoutMs?: number
}): Promise<EvalCaseExecution> {
  return executeCase({
    ...input,
    pluginEntry: input.installedEntry,
    artifactRefs: ['artifact/package.tgz', 'package/dist/index.js'],
  })
}
