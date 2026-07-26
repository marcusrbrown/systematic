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
    const stat = fs.lstatSync(absolutePath)
    const value = stat.isSymbolicLink()
      ? `symlink:${fs.readlinkSync(absolutePath)}`
      : `file:${createHash('sha256')
          .update(fs.readFileSync(absolutePath))
          .digest('hex')}:${stat.size}`
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
      const id = `receipt-probe-${requestIndex}`
      const created = Math.floor(Date.now() / 1000)
      return streamMockResponse(buildMockResponseChunks(response, id, created))
    },
  })

  return {
    url: `http://localhost:${server.port}/v1`,
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

export default async function receiptProbe() {
  append({ type: 'loaded', pid: process.pid })
  return {
    'tool.execute.after': async (input, output) => {
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

describe.skipIf(!OPENCODE_AVAILABLE)(
  'receipt workflow host characterization',
  () => {
    let fixture: IsolatedFixture
    let packagedPluginUrl: string

    beforeAll(() => {
      packTarballOnce()
    }, 200_000)

    afterAll(() => {
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
  },
)
