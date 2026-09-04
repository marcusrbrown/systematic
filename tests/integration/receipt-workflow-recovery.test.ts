import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'

import {
  cleanupPackedTarball,
  createIsolatedFixture,
  destroyIsolatedFixture,
  extractPackagedPlugin,
  type IsolatedFixture,
  OPENCODE_AVAILABLE,
  packTarballOnce,
  REPO_ROOT,
  startOpencodeServer,
  stopAllOpencodeHosts,
  TIMEOUT_MS,
} from './fixtures/receipt-workflow-host.js'

const MOCK_PROVIDER_ID = 'systematic-receipt-probe'
const MOCK_MODEL_ID = 'receipt-probe-model'
const RECEIPT_MARKER_KEY = 'receipt_probe_marker'
const RECEIPT_MARKER_VALUE = 'u5b-metadata-v1'

interface ScriptedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

interface ScriptedResponse {
  text?: string
  toolCalls?: ScriptedToolCall[]
}

interface MockModelServer {
  url: string
  requests: unknown[]
  stop(): void
}

interface RepositorySnapshot {
  status: string
  tracked: Map<string, string>
}

function snapshotRepositoryTree(): RepositorySnapshot {
  const status = Bun.spawnSync(
    ['git', 'status', '--short', '--untracked-files=all'],
    { cwd: REPO_ROOT },
  )
    .stdout.toString()
    .trim()
  const trackedOutput = Bun.spawnSync(['git', 'ls-files', '-z'], {
    cwd: REPO_ROOT,
  }).stdout.toString()
  const tracked = new Map<string, string>()
  for (const filePath of trackedOutput.split('\0').filter(Boolean)) {
    const absolutePath = path.join(REPO_ROOT, filePath)
    // Use readlinkSync to detect symlinks without a separate lstatSync, avoiding
    // a TOCTOU race between stat and read that CodeQL flags as a security issue.
    let value: string
    try {
      const linkTarget = fs.readlinkSync(absolutePath)
      value = `symlink:${linkTarget}`
    } catch {
      // Not a symlink — read file content directly (single atomic operation)
      const content = fs.readFileSync(absolutePath)
      value = `file:${createHash('sha256').update(content).digest('hex')}:${content.byteLength}`
    }
    tracked.set(filePath, value)
  }
  return { status, tracked }
}

function sseChunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function buildToolCallChunks(
  response: ScriptedResponse,
  id: string,
  created: number,
): Record<string, unknown>[] {
  const chunks =
    response.toolCalls?.map((toolCall, index) => ({
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
    })) ?? []
  return [
    ...chunks,
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model: MOCK_MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    },
  ]
}

function buildTextChunks(
  response: ScriptedResponse,
  id: string,
  created: number,
): Record<string, unknown>[] {
  const text = response.text ?? ''
  return [
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model: MOCK_MODEL_ID,
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
            id,
            object: 'chat.completion.chunk',
            created,
            model: MOCK_MODEL_ID,
            choices: [
              { index: 0, delta: { content: text }, finish_reason: null },
            ],
          },
        ]
      : []),
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model: MOCK_MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ]
}

function buildMockResponseChunks(
  response: ScriptedResponse,
  id: string,
  created: number,
): Record<string, unknown>[] {
  return response.toolCalls && response.toolCalls.length > 0
    ? buildToolCallChunks(response, id, created)
    : buildTextChunks(response, id, created)
}

function streamMockResponse(
  chunks: readonly Record<string, unknown>[],
): Response {
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
}

function startMockModelServer(
  responses: readonly ScriptedResponse[],
): MockModelServer {
  let requestIndex = 0
  const requests: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        !request.url.endsWith('/chat/completions')
      ) {
        return new Response('not found', { status: 404 })
      }

      requests.push(await request.json())
      const response = responses[requestIndex] ?? { text: '' }
      requestIndex += 1
      const id = `receipt-probe-${requestIndex}`
      const created = Math.floor(Date.now() / 1000)
      return streamMockResponse(buildMockResponseChunks(response, id, created))
    },
  })

  return {
    url: `http://localhost:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  }
}

function writeReceiptProbePlugin(fixture: IsolatedFixture): {
  url: string
  capturePath: string
} {
  const pluginDir = path.join(fixture.tempRoot, 'receipt-probe-plugin')
  const capturePath = path.join(fixture.tempRoot, 'receipt-probe-events.jsonl')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({
      name: 'receipt-workflow-probe',
      type: 'module',
      main: './index.mjs',
    }),
  )
  fs.writeFileSync(
    path.join(pluginDir, 'index.mjs'),
    `import fs from 'node:fs'

const capturePath = ${JSON.stringify(capturePath)}
const markerKey = ${JSON.stringify(RECEIPT_MARKER_KEY)}
const markerValue = ${JSON.stringify(RECEIPT_MARKER_VALUE)}

function append(entry) {
  fs.appendFileSync(capturePath, JSON.stringify(entry) + '\\n')
}

function outputShape(tool, output) {
  const metadata = output && typeof output.metadata === 'object' && output.metadata !== null
    ? output.metadata
    : undefined
  return {
    type: 'after-shape',
    tool,
    outputKeys: output && typeof output === 'object' ? Object.keys(output).sort() : [],
    title: {
      present: Boolean(output && Object.prototype.hasOwnProperty.call(output, 'title')),
      type: typeof output?.title,
      empty: output?.title === '',
    },
    output: {
      present: Boolean(output && Object.prototype.hasOwnProperty.call(output, 'output')),
      type: typeof output?.output,
      empty: output?.output === '',
    },
    metadata: {
      present: Boolean(output && Object.prototype.hasOwnProperty.call(output, 'metadata')),
      type: typeof output?.metadata,
      keys: metadata ? Object.keys(metadata).sort() : [],
      status: metadata?.status ?? null,
    },
  }
}

export default async function receiptProbe() {
  append({ type: 'loaded', pid: process.pid })
  return {
    'tool.execute.before': async (input, output) => {
      append({
        type: 'hook-call',
        phase: 'before',
        tool: input.tool,
        callID: input.callID,
        name: output.args && typeof output.args === 'object' ? output.args.name ?? null : null,
      })
    },
    'tool.execute.after': async (input, output) => {
      append(outputShape(input.tool, output))
      if (input.tool !== 'bash') return
      output.metadata = { ...(output.metadata ?? {}), [markerKey]: markerValue }
      append({ type: 'bash-after', sessionID: input.sessionID, callID: input.callID })
    },
  }
}
`,
  )

  return { url: new URL(`./`, `file://${pluginDir}/`).href, capturePath }
}

function writeTaskLineageProbePlugin(fixture: IsolatedFixture): {
  url: string
  capturePath: string
} {
  const pluginDir = path.join(fixture.tempRoot, 'task-lineage-probe-plugin')
  const capturePath = path.join(
    fixture.tempRoot,
    'task-lineage-probe-events.jsonl',
  )
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({
      name: 'task-lineage-probe',
      type: 'module',
      main: './index.mjs',
    }),
  )
  fs.writeFileSync(
    path.join(pluginDir, 'index.mjs'),
    `import fs from 'node:fs'

const capturePath = ${JSON.stringify(capturePath)}

function append(entry) {
  fs.appendFileSync(capturePath, JSON.stringify(entry) + '\\n')
}

export default async function taskLineageProbe() {
  append({ type: 'loaded', pid: process.pid })
  return {
    'tool.execute.before': async (input) => {
      if (input.tool !== 'task') return
      append({
        type: 'task-before',
        sessionID: input.sessionID,
        callID: input.callID,
        at: Date.now(),
      })
    },
    'tool.execute.after': async (input, output) => {
      if (input.tool !== 'task') return
      const metadata = output.metadata && typeof output.metadata === 'object'
        ? output.metadata
        : {}
      append({
        type: 'task-after',
        sessionID: input.sessionID,
        callID: input.callID,
        at: Date.now(),
        parentSessionID: typeof metadata.parentSessionId === 'string'
          ? metadata.parentSessionId
          : null,
        candidateChildSessionID: typeof metadata.childSessionId === 'string'
          ? metadata.childSessionId
          : null,
        sessionIDChildCandidate: typeof metadata.sessionId === 'string'
          ? metadata.sessionId
          : null,
      })
    },
    event: async ({ event }) => {
      if (!event || event.type !== 'session.idle') return
      const properties = event.properties && typeof event.properties === 'object'
        ? event.properties
        : {}
      if (typeof properties.sessionID !== 'string') return
      append({
        type: 'session-idle',
        sessionID: properties.sessionID,
        at: Date.now(),
      })
    },
  }
}
`,
  )

  return { url: new URL(`./`, `file://${pluginDir}/`).href, capturePath }
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
      [MOCK_PROVIDER_ID]: {
        name: 'Receipt Probe',
        id: MOCK_PROVIDER_ID,
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [MOCK_MODEL_ID]: {
            id: MOCK_MODEL_ID,
            name: 'Receipt Probe Model',
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: '2026-07-25',
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: 'unused-receipt-probe-key', baseURL: baseUrl },
      },
    },
  })
}

function readProbeEvents(capturePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(capturePath)) return []
  return fs
    .readFileSync(capturePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function completedBashParts(
  messages: unknown[],
): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object') return []
    const parts = (message as { parts?: unknown }).parts
    if (!Array.isArray(parts)) return []
    return parts.filter((part): part is Record<string, unknown> => {
      if (!part || typeof part !== 'object') return false
      const value = part as { type?: unknown; tool?: unknown; state?: unknown }
      if (value.type !== 'tool' || value.tool !== 'bash') return false
      if (!value.state || typeof value.state !== 'object') return false
      return (value.state as { status?: unknown }).status === 'completed'
    }) as Array<Record<string, unknown>>
  })
}

function completedToolParts(
  messages: unknown[],
  toolName: string,
): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object') return []
    const parts = (message as { parts?: unknown }).parts
    if (!Array.isArray(parts)) return []
    return parts.filter((part): part is Record<string, unknown> => {
      if (!part || typeof part !== 'object') return false
      const value = part as { type?: unknown; tool?: unknown; state?: unknown }
      if (value.type !== 'tool' || value.tool !== toolName) return false
      if (!value.state || typeof value.state !== 'object') return false
      return (value.state as { status?: unknown }).status === 'completed'
    }) as Array<Record<string, unknown>>
  })
}

function systematicMarkers(messages: unknown[]): unknown[] {
  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object') return []
    const parts = (message as { parts?: unknown }).parts
    if (!Array.isArray(parts)) return []
    return parts.flatMap((part) => {
      if (!part || typeof part !== 'object') return []
      const state = (part as { state?: unknown }).state
      if (!state || typeof state !== 'object') return []
      const metadata = (state as { metadata?: unknown }).metadata
      if (!metadata || typeof metadata !== 'object') return []
      const marker = (metadata as Record<string, unknown>)
        .systematic_workflow_receipt
      return marker === undefined ? [] : [marker]
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function receiptMintSummariesForValue(
  value: unknown,
): Array<{ operation: string; receiptId: string }> {
  const markers = Array.isArray(value) ? value : [value]
  return markers.flatMap((marker) => {
    if (!isRecord(marker) || marker.kind !== 'mint') return []
    const envelope = marker.envelope
    if (!isRecord(envelope) || !isRecord(envelope.canonical)) return []
    const { operation, receiptId } = envelope.canonical
    return typeof operation === 'string' && typeof receiptId === 'string'
      ? [{ operation, receiptId }]
      : []
  })
}

function receiptMintSummaries(
  messages: unknown[],
): Array<{ operation: string; receiptId: string }> {
  return systematicMarkers(messages).flatMap(receiptMintSummariesForValue)
}

function receiptMintSessionSalts(messages: unknown[]): string[] {
  return systematicMarkers(messages).flatMap((marker) => {
    if (!isRecord(marker) || marker.kind !== 'mint') return []
    return typeof marker.sessionSalt === 'string' ? [marker.sessionSalt] : []
  })
}

function assertPrivacySafeMarkers(messages: unknown[]): void {
  const serialized = JSON.stringify(systematicMarkers(messages))
  expect(serialized).not.toContain('u5-recovery.txt')
  expect(serialized).not.toContain('u5-child.txt')
  expect(serialized).not.toContain('opaque integration content')
  expect(serialized).not.toContain('Run the guarded workflow')
  expect(serialized).not.toContain('Use systematic tools in the child')
  for (const match of serialized.matchAll(/[a-f0-9]{64}/g)) {
    expect(match[0]).toMatch(/^[a-f0-9]{64}$/)
  }
}

async function createSession(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  title: string,
  permission = [{ permission: '*', pattern: '*', action: 'allow' as const }],
): Promise<string> {
  const created = await client.session.create({
    directory,
    title,
    permission,
  })
  return created.data.id
}

function initializeIsolatedRepository(
  fixture: IsolatedFixture,
  additionalTrackedFiles: readonly string[] = [],
): void {
  const commands = [
    ['git', 'init', '-b', 'main'],
    ['git', 'config', 'user.email', 'u5-integration@example.invalid'],
    ['git', 'config', 'user.name', 'U5 Integration'],
    ['git', 'add', 'package.json', ...additionalTrackedFiles],
    ['git', 'commit', '-m', 'initial fixture'],
  ]
  for (const command of commands) {
    const result = Bun.spawnSync(command, { cwd: fixture.projectDir })
    if (result.exitCode !== 0) {
      throw new Error(`isolated git setup failed: ${command[1] ?? command[0]}`)
    }
  }
}

async function promptSession(
  client: ReturnType<typeof createOpencodeClient>,
  sessionID: string,
  directory: string,
  text: string,
): Promise<void> {
  await client.session.prompt({
    sessionID,
    directory,
    model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
    parts: [{ type: 'text', text }],
  })
}

describe.skipIf(!OPENCODE_AVAILABLE)(
  'receipt workflow host characterization',
  () => {
    let fixture: IsolatedFixture
    let packagedPluginUrl: string

    beforeAll(() => {
      packTarballOnce()
    }, 200_000)

    afterAll(async () => {
      await stopAllOpencodeHosts()
      cleanupPackedTarball()
    })

    test(
      'persists built-in tool metadata across an isolated host restart',
      async () => {
        fixture = createIsolatedFixture()
        const probe = writeReceiptProbePlugin(fixture)
        packagedPluginUrl = extractPackagedPlugin(fixture).pluginUrl
        const model = startMockModelServer([
          {
            toolCalls: [
              {
                id: 'receipt-bash-call',
                name: 'bash',
                arguments: { command: 'printf receipt-probe' },
              },
            ],
          },
          { text: 'done' },
        ])
        const configContent = buildProviderConfig(
          [probe.url, packagedPluginUrl],
          model.url,
        )

        const firstHost = await startOpencodeServer(fixture, configContent)
        const firstClient = createOpencodeClient({
          baseUrl: firstHost.url,
          directory: fixture.projectDir,
        })
        const created = await firstClient.session.create({
          directory: fixture.projectDir,
          title: 'receipt metadata probe',
          permission: [{ permission: '*', pattern: '*', action: 'allow' }],
        })
        const sessionID = created.data.id
        await firstClient.session.prompt({
          sessionID,
          directory: fixture.projectDir,
          model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
          parts: [{ type: 'text', text: 'Run the built-in bash tool once.' }],
        })

        const firstMessages = await firstClient.session.messages({
          sessionID,
          directory: fixture.projectDir,
        })
        const firstBashParts = completedBashParts(firstMessages.data)
        expect(firstBashParts).toHaveLength(1)
        const firstState = firstBashParts[0]?.state as Record<string, unknown>
        const firstMetadata = firstState.metadata as Record<string, unknown>
        expect(firstMetadata[RECEIPT_MARKER_KEY]).toBe(RECEIPT_MARKER_VALUE)
        expect(
          readProbeEvents(probe.capturePath).filter(
            (event) => event.type === 'after-shape',
          ),
        ).toEqual([
          {
            type: 'after-shape',
            tool: 'bash',
            outputKeys: ['attachments', 'metadata', 'output', 'title'],
            title: { present: true, type: 'string', empty: false },
            output: { present: true, type: 'string', empty: false },
            metadata: {
              present: true,
              type: 'object',
              keys: ['exit', 'output', 'truncated'],
              status: null,
            },
          },
        ])
        const firstPid = firstHost.pid
        await firstHost.stop()

        const secondHost = await startOpencodeServer(fixture, configContent)
        try {
          expect(secondHost.pid).not.toBe(firstPid)
          const secondClient = createOpencodeClient({
            baseUrl: secondHost.url,
            directory: fixture.projectDir,
          })
          const secondMessages = await secondClient.session.messages({
            sessionID,
            directory: fixture.projectDir,
          })
          const secondBashParts = completedBashParts(secondMessages.data)
          expect(secondBashParts).toHaveLength(1)
          const secondState = secondBashParts[0]?.state as Record<
            string,
            unknown
          >
          const secondMetadata = secondState.metadata as Record<string, unknown>
          expect(secondMetadata[RECEIPT_MARKER_KEY]).toBe(RECEIPT_MARKER_VALUE)
          const loadedPids = readProbeEvents(probe.capturePath)
            .filter((event) => event.type === 'loaded')
            .map((event) => event.pid)
          expect(loadedPids).toEqual([firstPid, secondHost.pid])
        } finally {
          await secondHost.stop()
          model.stop()
          destroyIsolatedFixture(fixture)
        }
      },
      TIMEOUT_MS * 2,
    )

    test(
      'characterizes fork identity and persisted tool-part field continuity',
      async () => {
        const localFixture = createIsolatedFixture()
        const probe = writeReceiptProbePlugin(localFixture)
        const localPackagedPluginUrl =
          extractPackagedPlugin(localFixture).pluginUrl
        const model = startMockModelServer([
          {
            toolCalls: [
              {
                id: 'receipt-fork-bash-call',
                name: 'bash',
                arguments: { command: 'printf fork-probe' },
              },
            ],
          },
          { text: 'first complete' },
          { text: 'second complete' },
        ])
        const configContent = buildProviderConfig(
          [probe.url, localPackagedPluginUrl],
          model.url,
        )
        const host = await startOpencodeServer(localFixture, configContent)

        try {
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: localFixture.projectDir,
          })
          const created = await client.session.create({
            directory: localFixture.projectDir,
            title: 'receipt fork probe',
            permission: [{ permission: '*', pattern: '*', action: 'allow' }],
          })
          const sessionID = created.data.id
          await client.session.prompt({
            sessionID,
            directory: localFixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [{ type: 'text', text: 'Run the built-in bash tool once.' }],
          })
          const secondPrompt = await client.session.prompt({
            sessionID,
            directory: localFixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [{ type: 'text', text: 'Reply with one short sentence.' }],
          })

          const sourceMessages = await client.session.messages({
            sessionID,
            directory: localFixture.projectDir,
          })
          const sourcePart = completedBashParts(sourceMessages.data)[0]
          expect(sourcePart).toBeDefined()
          const sourceState = sourcePart?.state as Record<string, unknown>
          const sourceMetadata = sourceState.metadata as Record<string, unknown>

          const forked = await client.session.fork({
            sessionID,
            directory: localFixture.projectDir,
            messageID: secondPrompt.data.info.id,
          })
          expect(forked.data.id).not.toBe(sessionID)
          expect({
            parentIDPresent: typeof forked.data.parentID === 'string',
            parentIDMatchesSource: forked.data.parentID === sessionID,
          }).toEqual({ parentIDPresent: false, parentIDMatchesSource: false })

          const childMessages = await client.session.messages({
            sessionID: forked.data.id,
            directory: localFixture.projectDir,
          })
          const childPart = completedBashParts(childMessages.data)[0]
          expect(childPart).toBeDefined()
          const childState = childPart?.state as Record<string, unknown>
          const childMetadata = childState.metadata as Record<string, unknown>
          expect({
            partTypePreserved: childPart?.type === sourcePart?.type,
            toolPreserved: childPart?.tool === sourcePart?.tool,
            statusPreserved: childState.status === sourceState.status,
            markerPreserved:
              childMetadata[RECEIPT_MARKER_KEY] ===
              sourceMetadata[RECEIPT_MARKER_KEY],
            callIDPreserved: childPart?.callID === sourcePart?.callID,
            messageIDReassigned: childPart?.messageID !== sourcePart?.messageID,
            partIDReassigned: childPart?.id !== sourcePart?.id,
          }).toEqual({
            partTypePreserved: true,
            toolPreserved: true,
            statusPreserved: true,
            markerPreserved: true,
            callIDPreserved: true,
            messageIDReassigned: true,
            partIDReassigned: true,
          })

          const children = await client.session.children({
            sessionID,
            directory: localFixture.projectDir,
          })
          expect(
            children.data.some((child) => child.id === forked.data.id),
          ).toBe(false)
        } finally {
          await host.stop()
          model.stop()
          destroyIsolatedFixture(localFixture)
        }
      },
      TIMEOUT_MS * 2,
    )

    test(
      'characterizes foreground task child identity and completion ordering',
      async () => {
        const localFixture = createIsolatedFixture()
        const probe = writeTaskLineageProbePlugin(localFixture)
        const localPackagedPluginUrl =
          extractPackagedPlugin(localFixture).pluginUrl
        const model = startMockModelServer([
          {
            toolCalls: [
              {
                id: 'receipt-task-call',
                name: 'task',
                arguments: {
                  description: 'lineage probe',
                  prompt: 'Reply with one short sentence and do not use tools.',
                  subagent_type: 'systematic-implementer',
                },
              },
            ],
          },
          { text: 'child complete' },
          { text: 'parent complete' },
        ])
        const configContent = buildProviderConfig(
          [probe.url, localPackagedPluginUrl],
          model.url,
        )
        const host = await startOpencodeServer(localFixture, configContent)

        try {
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: localFixture.projectDir,
          })
          const created = await client.session.create({
            directory: localFixture.projectDir,
            title: 'receipt task lineage probe',
            permission: [{ permission: '*', pattern: '*', action: 'allow' }],
          })
          const sessionID = created.data.id
          await client.session.prompt({
            sessionID,
            directory: localFixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [
              {
                type: 'text',
                text: 'Run one foreground task and wait for it.',
              },
            ],
          })

          const events = readProbeEvents(probe.capturePath)
          const before = events.find((event) => event.type === 'task-before')
          const after = events.find((event) => event.type === 'task-after')
          expect(before).toBeDefined()
          expect(after).toBeDefined()
          const childSessionID = after?.sessionIDChildCandidate
          if (typeof childSessionID !== 'string') {
            throw new Error('U5B_TASK_CHILD_IDENTITY_MISSING')
          }
          expect(childSessionID).toMatch(/^ses_/)

          expect({
            parentSessionMatches: after?.sessionID === sessionID,
            beforeAfterCallIDMatches: before?.callID === after?.callID,
            afterMetadataParentMatches: after?.parentSessionID === sessionID,
          }).toEqual({
            parentSessionMatches: true,
            beforeAfterCallIDMatches: true,
            afterMetadataParentMatches: true,
          })

          const children = await client.session.children({
            sessionID,
            directory: localFixture.projectDir,
          })
          const child = children.data.find(
            (entry) => entry.id === childSessionID,
          )
          expect(child).toBeDefined()
          expect(child?.parentID).toBe(sessionID)

          const childMessages = await client.session.messages({
            sessionID: childSessionID,
            directory: localFixture.projectDir,
          })
          expect(childMessages.data.length).toBeGreaterThan(0)
          const childTextPartCount = childMessages.data.reduce(
            (count, message) =>
              count +
              message.parts.filter((part) => part.type === 'text').length,
            0,
          )
          expect(childTextPartCount).toBeGreaterThan(0)

          const parentMessages = await client.session.messages({
            sessionID,
            directory: localFixture.projectDir,
          })
          const parentTaskParts = completedToolParts(
            parentMessages.data,
            'task',
          )
          expect(parentTaskParts).toHaveLength(1)
          const parentTaskState = parentTaskParts[0]?.state as Record<
            string,
            unknown
          >
          const parentTaskMetadata = parentTaskState.metadata as Record<
            string,
            unknown
          >
          expect(parentTaskMetadata.sessionId).toBe(childSessionID)

          const childIdleAt = events
            .filter(
              (event) =>
                event.type === 'session-idle' &&
                event.sessionID === childSessionID,
            )
            .map((event) => event.at)
            .find((value): value is number => typeof value === 'number')
          if (childIdleAt === undefined) {
            throw new Error('U5B_TASK_CHILD_IDLE_EVENT_MISSING')
          }
          expect(childIdleAt).toBeLessThanOrEqual(after?.at as number)
        } finally {
          await host.stop()
          model.stop()
          destroyIsolatedFixture(localFixture)
        }
      },
      TIMEOUT_MS * 2,
    )

    test(
      'keeps the repository tree unchanged while using disposable host roots',
      async () => {
        const before = snapshotRepositoryTree()
        const localFixture = createIsolatedFixture()
        const probe = writeReceiptProbePlugin(localFixture)
        const localPackagedPluginUrl =
          extractPackagedPlugin(localFixture).pluginUrl
        const model = startMockModelServer([{ text: 'probe complete' }])
        const configContent = buildProviderConfig(
          [probe.url, localPackagedPluginUrl],
          model.url,
        )
        const host = await startOpencodeServer(localFixture, configContent)

        try {
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: localFixture.projectDir,
          })
          const created = await client.session.create({
            directory: localFixture.projectDir,
            title: 'receipt privacy probe',
            permission: [{ permission: '*', pattern: '*', action: 'allow' }],
          })
          await client.session.prompt({
            sessionID: created.data.id,
            directory: localFixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [{ type: 'text', text: 'Reply once.' }],
          })
        } finally {
          await host.stop()
          model.stop()
          destroyIsolatedFixture(localFixture)
        }

        const after = snapshotRepositoryTree()
        expect(after.status).toBe(before.status)
        expect(Array.from(after.tracked.entries())).toEqual(
          Array.from(before.tracked.entries()),
        )
      },
      TIMEOUT_MS * 2,
    )

    test(
      'recovers persisted workflow state across a real host restart',
      async () => {
        const localFixture = createIsolatedFixture()
        initializeIsolatedRepository(localFixture)
        const hookProbe = writeReceiptProbePlugin(localFixture)
        const localPackagedPluginUrl =
          extractPackagedPlugin(localFixture).pluginUrl
        const model = startMockModelServer([
          {
            toolCalls: [
              {
                id: 'u5-recovery-skill',
                name: 'systematic_skill',
                arguments: { name: 'ce:work' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5-recovery-start',
                name: 'systematic_workflow_start',
                arguments: { expected_operations: ['implementation'] },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5-recovery-write',
                name: 'write',
                arguments: {
                  filePath: 'u5-recovery.txt',
                  content: 'opaque integration content',
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5-recovery-verification',
                name: 'bash',
                arguments: { command: 'git status --short' },
              },
            ],
          },
          { text: 'first workflow turn complete' },
          {
            toolCalls: [
              {
                id: 'u5-recovery-status',
                name: 'systematic_workflow_status',
                arguments: {},
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5-recovery-complete',
                name: 'systematic_workflow_complete',
                arguments: { target: 'unit' },
              },
            ],
          },
          { text: 'recovered workflow turn complete' },
        ])
        const configContent = buildProviderConfig(
          [hookProbe.url, localPackagedPluginUrl],
          model.url,
        )
        let firstHost:
          | Awaited<ReturnType<typeof startOpencodeServer>>
          | undefined
        let secondHost:
          | Awaited<ReturnType<typeof startOpencodeServer>>
          | undefined

        try {
          firstHost = await startOpencodeServer(localFixture, configContent)
          const firstClient = createOpencodeClient({
            baseUrl: firstHost.url,
            directory: localFixture.projectDir,
          })
          const sessionID = await createSession(
            firstClient,
            localFixture.projectDir,
            'u5 restart recovery',
          )
          await promptSession(
            firstClient,
            sessionID,
            localFixture.projectDir,
            'Run the guarded workflow and make one implementation change.',
          )

          const beforeRestart = await firstClient.session.messages({
            sessionID,
            directory: localFixture.projectDir,
          })
          const beforeSkillParts = completedToolParts(
            beforeRestart.data,
            'systematic_skill',
          )
          expect(beforeSkillParts).toHaveLength(1)
          const beforeSkillState = beforeSkillParts[0]?.state as Record<
            string,
            unknown
          >
          const beforeSkillOutput = beforeSkillState.output
          expect(typeof beforeSkillOutput === 'string').toBe(true)
          expect(beforeSkillOutput).toContain('<skill_content name="ce:work">')
          expect(beforeSkillOutput).toContain('# Skill: ce:work')
          expect(beforeSkillOutput).toContain('Base directory for this skill:')
          const beforeMarkers = systematicMarkers(beforeRestart.data)
          expect(
            readProbeEvents(hookProbe.capturePath).filter(
              (event) => event.type === 'after-shape',
            ),
          ).toEqual([
            {
              type: 'after-shape',
              tool: 'systematic_skill',
              outputKeys: ['attachments', 'metadata', 'output', 'title'],
              title: { present: true, type: 'string', empty: true },
              output: {
                present: true,
                type: 'string',
                empty: false,
              },
              metadata: {
                present: true,
                type: 'object',
                keys: ['truncated'],
                status: null,
              },
            },
            {
              type: 'after-shape',
              tool: 'systematic_workflow_start',
              outputKeys: ['attachments', 'metadata', 'output', 'title'],
              title: { present: true, type: 'string', empty: false },
              output: {
                present: true,
                type: 'string',
                empty: false,
              },
              metadata: {
                present: true,
                type: 'object',
                keys: [
                  'enforcement',
                  'protocolVersion',
                  'reasonCode',
                  'sourceDigest',
                  'state',
                  'statusDigest',
                  'truncated',
                ],
                status: null,
              },
            },
            {
              type: 'after-shape',
              tool: 'write',
              outputKeys: ['attachments', 'metadata', 'output', 'title'],
              title: { present: true, type: 'string', empty: false },
              output: {
                present: true,
                type: 'string',
                empty: false,
              },
              metadata: {
                present: true,
                type: 'object',
                keys: ['diagnostics', 'exists', 'filepath', 'truncated'],
                status: null,
              },
            },
            {
              type: 'after-shape',
              tool: 'bash',
              outputKeys: ['attachments', 'metadata', 'output', 'title'],
              title: { present: true, type: 'string', empty: false },
              output: {
                present: true,
                type: 'string',
                empty: false,
              },
              metadata: {
                present: true,
                type: 'object',
                keys: ['exit', 'output', 'truncated'],
                status: null,
              },
            },
          ])
          expect(beforeMarkers.length).toBeGreaterThan(0)
          assertPrivacySafeMarkers(beforeRestart.data)
          const firstPID = firstHost.pid
          await firstHost.stop()
          firstHost = undefined

          secondHost = await startOpencodeServer(localFixture, configContent)
          expect(secondHost.pid).not.toBe(firstPID)
          const secondClient = createOpencodeClient({
            baseUrl: secondHost.url,
            directory: localFixture.projectDir,
          })
          const persisted = await secondClient.session.messages({
            sessionID,
            directory: localFixture.projectDir,
          })
          expect(systematicMarkers(persisted.data).length).toBe(
            beforeMarkers.length,
          )
          await promptSession(
            secondClient,
            sessionID,
            localFixture.projectDir,
            'Read the recovered workflow status, then complete the unit.',
          )
          const afterRecovery = await secondClient.session.messages({
            sessionID,
            directory: localFixture.projectDir,
          })
          const completionParts = completedToolParts(
            afterRecovery.data,
            'systematic_workflow_complete',
          )
          expect(completionParts.length).toBeGreaterThan(0)
          const completionSucceeded = completionParts.some((part) => {
            const state = part.state
            if (!state || typeof state !== 'object') return false
            const output = (state as { output?: unknown }).output
            return typeof output === 'string' && output.includes('completed')
          })
          expect(completionSucceeded).toBe(true)
          assertPrivacySafeMarkers(afterRecovery.data)
        } finally {
          if (firstHost) await firstHost.stop()
          if (secondHost) await secondHost.stop()
          model.stop()
          destroyIsolatedFixture(localFixture)
        }
      },
      TIMEOUT_MS * 3,
    )

    test(
      'does not recover a satisfied workflow from a session without markers',
      async () => {
        const localFixture = createIsolatedFixture()
        const localPackagedPluginUrl =
          extractPackagedPlugin(localFixture).pluginUrl
        const model = startMockModelServer([
          { text: 'no persisted workflow state' },
          {
            toolCalls: [
              {
                id: 'u5-empty-status',
                name: 'systematic_workflow_status',
                arguments: {},
              },
            ],
          },
          { text: 'status checked' },
        ])
        const configContent = buildProviderConfig(
          [localPackagedPluginUrl],
          model.url,
        )
        let firstHost:
          | Awaited<ReturnType<typeof startOpencodeServer>>
          | undefined
        let secondHost:
          | Awaited<ReturnType<typeof startOpencodeServer>>
          | undefined
        try {
          firstHost = await startOpencodeServer(localFixture, configContent)
          const firstClient = createOpencodeClient({
            baseUrl: firstHost.url,
            directory: localFixture.projectDir,
          })
          const sessionID = await createSession(
            firstClient,
            localFixture.projectDir,
            'u5 empty recovery',
          )
          await promptSession(
            firstClient,
            sessionID,
            localFixture.projectDir,
            'Reply without using workflow tools.',
          )
          await firstHost.stop()
          firstHost = undefined
          secondHost = await startOpencodeServer(localFixture, configContent)
          const secondClient = createOpencodeClient({
            baseUrl: secondHost.url,
            directory: localFixture.projectDir,
          })
          await promptSession(
            secondClient,
            sessionID,
            localFixture.projectDir,
            'Check workflow status only.',
          )
          const messages = await secondClient.session.messages({
            sessionID,
            directory: localFixture.projectDir,
          })
          const statusParts = completedToolParts(
            messages.data,
            'systematic_workflow_status',
          )
          expect(statusParts.length).toBeGreaterThan(0)
          expect(
            statusParts.some((part) => {
              const state = part.state
              if (!state || typeof state !== 'object') return false
              const output = (state as { output?: unknown }).output
              return (
                typeof output === 'string' &&
                output.includes('"state":"completed"')
              )
            }),
          ).toBe(false)
        } finally {
          if (firstHost) await firstHost.stop()
          if (secondHost) await secondHost.stop()
          model.stop()
          destroyIsolatedFixture(localFixture)
        }
      },
      TIMEOUT_MS * 3,
    )

    test(
      'observes a real foreground child lineage and parent rollup marker',
      async () => {
        const localFixture = createIsolatedFixture()
        initializeIsolatedRepository(localFixture)
        const localPackagedPluginUrl =
          extractPackagedPlugin(localFixture).pluginUrl
        const model = startMockModelServer([
          {
            toolCalls: [
              {
                id: 'u5-parent-skill',
                name: 'systematic_skill',
                arguments: { name: 'ce:work' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5-parent-start',
                name: 'systematic_workflow_start',
                arguments: { expected_operations: ['implementation'] },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5-parent-task',
                name: 'task',
                arguments: {
                  description: 'foreground child receipt lane',
                  prompt:
                    'Use systematic tools in the child and make one change.',
                  subagent_type: 'systematic-implementer',
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5-child-skill',
                name: 'systematic_skill',
                arguments: { name: 'ce:work' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5-child-start',
                name: 'systematic_workflow_start',
                arguments: { expected_operations: ['implementation'] },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5-child-write',
                name: 'write',
                arguments: {
                  filePath: 'u5-child.txt',
                  content: 'opaque integration content',
                },
              },
            ],
          },
          { text: 'child finished' },
          { text: 'parent finished' },
        ])
        const configContent = buildProviderConfig(
          [localPackagedPluginUrl],
          model.url,
        )
        let host: Awaited<ReturnType<typeof startOpencodeServer>> | undefined
        try {
          host = await startOpencodeServer(localFixture, configContent)
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: localFixture.projectDir,
          })
          const parentSessionID = await createSession(
            client,
            localFixture.projectDir,
            'u5 foreground child rollup',
          )
          await promptSession(
            client,
            parentSessionID,
            localFixture.projectDir,
            'Start a guarded unit and run one foreground child.',
          )

          const parentMessages = await client.session.messages({
            sessionID: parentSessionID,
            directory: localFixture.projectDir,
          })
          const taskParts = completedToolParts(parentMessages.data, 'task')
          expect(taskParts).toHaveLength(1)
          const taskState = taskParts[0]?.state as Record<string, unknown>
          const taskMetadata = taskState.metadata as Record<string, unknown>
          const childSessionID = taskMetadata.sessionId
          expect(typeof childSessionID).toBe('string')

          const children = await client.session.children({
            sessionID: parentSessionID,
            directory: localFixture.projectDir,
          })
          const child = children.data.find(
            (entry) => entry.id === childSessionID,
          )
          expect(child).toBeDefined()
          expect(child?.parentID).toBe(parentSessionID)

          const childMessages = await client.session.messages({
            sessionID: childSessionID as string,
            directory: localFixture.projectDir,
          })
          const childMarkers = systematicMarkers(childMessages.data)
          expect(childMarkers.length).toBeGreaterThan(0)
          assertPrivacySafeMarkers(childMessages.data)

          const parentMints = receiptMintSummaries(parentMessages.data)
          expect(parentMints).toHaveLength(1)
          expect(parentMints[0]?.operation).toBe('implementation')
          const repeatedParentMessages = await client.session.messages({
            sessionID: parentSessionID,
            directory: localFixture.projectDir,
          })
          const repeatedParentMints = receiptMintSummaries(
            repeatedParentMessages.data,
          )
          expect(repeatedParentMints).toEqual(parentMints)
          assertPrivacySafeMarkers(parentMessages.data)
        } finally {
          if (host) await host.stop()
          model.stop()
          destroyIsolatedFixture(localFixture)
        }
      },
      TIMEOUT_MS * 4,
    )

    test(
      'rolls up a foreground child commit despite a stale earlier implementation receipt',
      async () => {
        const localFixture = createIsolatedFixture()
        initializeIsolatedRepository(localFixture)
        const localPackagedPluginUrl =
          extractPackagedPlugin(localFixture).pluginUrl
        const model = startMockModelServer([
          {
            toolCalls: [
              {
                id: 'u5b-parent-skill',
                name: 'systematic_skill',
                arguments: { name: 'ce:work' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5b-parent-start',
                name: 'systematic_workflow_start',
                arguments: {
                  expected_operations: [
                    'implementation',
                    'verification',
                    'commit',
                  ],
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5b-parent-task',
                name: 'task',
                arguments: {
                  description: 'foreground child commit lane',
                  prompt:
                    'Use systematic tools in the child, write a file, then commit it.',
                  subagent_type: 'systematic-implementer',
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5b-child-skill',
                name: 'systematic_skill',
                arguments: { name: 'git-commit' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5b-child-start',
                name: 'systematic_workflow_start',
                arguments: {},
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5b-child-write',
                name: 'write',
                arguments: {
                  filePath: 'u5b-child.txt',
                  content: 'opaque integration content',
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5b-child-verify',
                name: 'bash',
                arguments: { command: 'git status --short' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5b-child-add',
                name: 'bash',
                arguments: { command: 'git add -A' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5b-child-commit',
                name: 'bash',
                arguments: { command: 'git commit -m u5b-commit-message' },
              },
            ],
          },
          { text: 'child committed' },
          { text: 'parent finished' },
          {
            toolCalls: [
              {
                id: 'u5b-parent-status',
                name: 'systematic_workflow_status',
                arguments: {},
              },
            ],
          },
          { text: 'status checked' },
        ])
        const configContent = buildProviderConfig(
          [localPackagedPluginUrl],
          model.url,
        )
        let host: Awaited<ReturnType<typeof startOpencodeServer>> | undefined
        try {
          host = await startOpencodeServer(localFixture, configContent)
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: localFixture.projectDir,
          })
          const parentSessionID = await createSession(
            client,
            localFixture.projectDir,
            'u5b foreground child commit rollup',
          )
          await promptSession(
            client,
            parentSessionID,
            localFixture.projectDir,
            'Start a guarded unit and run one foreground child that commits a change.',
          )

          const parentMessages = await client.session.messages({
            sessionID: parentSessionID,
            directory: localFixture.projectDir,
          })
          const taskParts = completedToolParts(parentMessages.data, 'task')
          expect(taskParts).toHaveLength(1)
          const taskState = taskParts[0]?.state as Record<string, unknown>
          const taskMetadata = taskState.metadata as Record<string, unknown>
          const childSessionID = taskMetadata.sessionId
          expect(typeof childSessionID).toBe('string')

          const children = await client.session.children({
            sessionID: parentSessionID,
            directory: localFixture.projectDir,
          })
          const child = children.data.find(
            (entry) => entry.id === childSessionID,
          )
          expect(child).toBeDefined()
          expect(child?.parentID).toBe(parentSessionID)

          const childMessages = await client.session.messages({
            sessionID: childSessionID as string,
            directory: localFixture.projectDir,
          })
          const childMarkers = systematicMarkers(childMessages.data)
          expect(childMarkers.length).toBeGreaterThan(0)
          assertPrivacySafeMarkers(childMessages.data)
          const childSessionSalts = receiptMintSessionSalts(childMessages.data)
          expect(childSessionSalts.length).toBeGreaterThan(0)
          const childSessionSalt = childSessionSalts[0]
          if (childSessionSalt === undefined) {
            throw new Error('child receipt session salt missing')
          }
          expect(model.requests.length).toBeGreaterThan(1)
          expect(JSON.stringify(model.requests.slice(1))).not.toContain(
            childSessionSalt,
          )

          await promptSession(
            client,
            parentSessionID,
            localFixture.projectDir,
            'Check workflow status only.',
          )
          const afterStatusMessages = await client.session.messages({
            sessionID: parentSessionID,
            directory: localFixture.projectDir,
          })
          const statusParts = completedToolParts(
            afterStatusMessages.data,
            'systematic_workflow_status',
          )
          expect(statusParts.length).toBeGreaterThan(0)
          const lastStatus = statusParts.at(-1)
          const lastStatusState = lastStatus?.state as Record<string, unknown>
          const lastStatusOutput = (lastStatusState as { output?: unknown })
            .output
          expect(typeof lastStatusOutput).toBe('string')
          const parsedStatus = JSON.parse(lastStatusOutput as string) as {
            state: string
            reasonCode: string
            satisfiedOperations: string[]
          }
          // The bug: an earlier implementation receipt from the same
          // foreground child, whose mutable revision digests are stale
          // relative to the final HEAD after the child's own commit,
          // must not make the parent's rollup fail closed before the
          // matching (later, current) commit receipt is evaluated.
          expect(parsedStatus.state).not.toBe('unavailable')
          expect(parsedStatus.reasonCode).not.toBe('guard-unavailable')
          expect(parsedStatus.satisfiedOperations).toContain('commit')
          assertPrivacySafeMarkers(afterStatusMessages.data)
        } finally {
          if (host) await host.stop()
          model.stop()
          destroyIsolatedFixture(localFixture)
        }
      },
      TIMEOUT_MS * 4,
    )

    test(
      '#678 reproduction: rolls up parent-rooted child tools targeting a registered nested worktree and completes',
      async () => {
        // Regression guard for 3420c5c and earlier: the parent-rooted child
        // remains in the host checkout while its bash tools target the nested
        // worktree. The former fixed-root observer therefore saw no change,
        // minted no parent receipts, and blocked completion.
        const localFixture = createIsolatedFixture()
        // Mirror the real repo's gitignored .worktrees/ directory and the
        // actual #678 dogfood worktree so the parent observer skips nested
        // worktree contents during its untracked-file walk.
        fs.writeFileSync(
          path.join(localFixture.projectDir, '.gitignore'),
          '.worktrees/\n',
        )
        initializeIsolatedRepository(localFixture, ['.gitignore'])
        const nestedWorktree = path.join(
          localFixture.projectDir,
          '.worktrees',
          'u5c-nested-target',
        )
        fs.mkdirSync(path.dirname(nestedWorktree), { recursive: true })
        const worktreeResult = Bun.spawnSync(
          ['git', 'worktree', 'add', '-b', 'u5c-nested-target', nestedWorktree],
          { cwd: localFixture.projectDir },
        )
        if (worktreeResult.exitCode !== 0) {
          throw new Error('isolated nested worktree setup failed')
        }
        fs.writeFileSync(
          path.join(nestedWorktree, 'change.patch'),
          'diff --git a/u5c-targeted.txt b/u5c-targeted.txt\n' +
            'new file mode 100644\n' +
            'index 0000000..2e4c4a1\n' +
            '--- /dev/null\n' +
            '+++ b/u5c-targeted.txt\n' +
            '@@ -0,0 +1 @@\n' +
            '+nested worktree content\n',
        )

        const localPackagedPluginUrl =
          extractPackagedPlugin(localFixture).pluginUrl
        const targetFile = path.join(nestedWorktree, 'u5c-targeted.txt')
        const model = startMockModelServer([
          {
            toolCalls: [
              {
                id: 'u5c-parent-skill',
                name: 'systematic_skill',
                arguments: { name: 'ce:work' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5c-parent-start',
                name: 'systematic_workflow_start',
                arguments: {
                  expected_operations: [
                    'implementation',
                    'verification',
                    'commit',
                  ],
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5c-parent-write-task',
                name: 'task',
                arguments: {
                  description: 'write in the nested worktree',
                  prompt:
                    'Use systematic tools and write one file in the target worktree.',
                  subagent_type: 'systematic-implementer',
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5c-child-write-skill',
                name: 'systematic_skill',
                arguments: { name: 'ce:work' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5c-child-write-start',
                name: 'systematic_workflow_start',
                arguments: { expected_operations: ['implementation'] },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5c-child-write',
                name: 'bash',
                arguments: {
                  command: 'git apply change.patch',
                  workdir: nestedWorktree,
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5c-child-write-verify',
                name: 'bash',
                arguments: {
                  command: 'git status --short',
                  workdir: nestedWorktree,
                },
              },
            ],
          },
          { text: 'nested worktree write finished' },
          {
            toolCalls: [
              {
                id: 'u5c-parent-commit-task',
                name: 'task',
                arguments: {
                  description: 'commit the nested worktree change',
                  prompt:
                    'Use systematic tools to commit the existing target worktree change.',
                  subagent_type: 'systematic-implementer',
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5c-child-commit-skill',
                name: 'systematic_skill',
                arguments: { name: 'git-commit' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5c-child-commit-start',
                name: 'systematic_workflow_start',
                arguments: {},
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5c-child-commit-status',
                name: 'bash',
                arguments: {
                  command: 'git status --short',
                  workdir: nestedWorktree,
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5c-child-commit-add',
                name: 'bash',
                arguments: {
                  command: 'git add -A',
                  workdir: nestedWorktree,
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'u5c-child-commit',
                name: 'bash',
                arguments: {
                  command: 'git commit -m u5c-nested-worktree-commit',
                  workdir: nestedWorktree,
                },
              },
            ],
          },
          { text: 'nested worktree commit finished' },
          {
            toolCalls: [
              {
                id: 'u5c-parent-complete',
                name: 'systematic_workflow_complete',
                arguments: { target: 'unit' },
              },
            ],
          },
          { text: 'nested worktree workflow completed' },
        ])
        const configContent = buildProviderConfig(
          [localPackagedPluginUrl],
          model.url,
        )
        let host: Awaited<ReturnType<typeof startOpencodeServer>> | undefined
        try {
          host = await startOpencodeServer(localFixture, configContent)
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: localFixture.projectDir,
          })
          const parentSessionID = await createSession(
            client,
            localFixture.projectDir,
            'u5c nested worktree rollup',
            [
              { permission: '*', pattern: '*', action: 'allow' },
              {
                permission: 'external_directory',
                pattern: '*',
                action: 'allow',
              },
              { permission: 'edit', pattern: '*', action: 'allow' },
            ],
          )
          await promptSession(
            client,
            parentSessionID,
            localFixture.projectDir,
            'Start a guarded unit, write in the nested worktree, then commit it.',
          )

          const parentMessages = await client.session.messages({
            sessionID: parentSessionID,
            directory: localFixture.projectDir,
          })
          const taskParts = completedToolParts(parentMessages.data, 'task')
          expect(taskParts).toHaveLength(2)
          const childSessionIDs = taskParts.map((part) => {
            const state = part.state as Record<string, unknown>
            const metadata = state.metadata as Record<string, unknown>
            const childSessionID = metadata.sessionId
            expect(typeof childSessionID).toBe('string')
            return childSessionID as string
          })

          const children = await client.session.children({
            sessionID: parentSessionID,
            directory: localFixture.projectDir,
          })
          for (const childSessionID of childSessionIDs) {
            const child = children.data.find(
              (entry) => entry.id === childSessionID,
            )
            expect(child).toBeDefined()
            expect(child?.parentID).toBe(parentSessionID)
            const childMessages = await client.session.messages({
              sessionID: childSessionID,
              directory: localFixture.projectDir,
            })
            expect(
              systematicMarkers(childMessages.data).length,
            ).toBeGreaterThan(0)
            assertPrivacySafeMarkers(childMessages.data)
          }

          expect(fs.existsSync(targetFile)).toBe(true)
          const parentMints = receiptMintSummaries(parentMessages.data)
          expect(parentMints.map(({ operation }) => operation)).toEqual([
            'implementation',
            'verification',
            'commit',
          ])
          const completionParts = completedToolParts(
            parentMessages.data,
            'systematic_workflow_complete',
          )
          expect(completionParts).toHaveLength(1)
          const completionState = completionParts[0]?.state as Record<
            string,
            unknown
          >
          expect(completionState.output).toContain(
            'workflow guard completed unit',
          )
          expect(receiptMintSummaries(parentMessages.data)).toEqual(parentMints)
          assertPrivacySafeMarkers(parentMessages.data)
        } finally {
          if (host) await host.stop()
          model.stop()
          destroyIsolatedFixture(localFixture)
        }
      },
      TIMEOUT_MS * 4,
    )
  },
)
