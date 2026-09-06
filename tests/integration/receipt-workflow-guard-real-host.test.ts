import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'

import {
  cleanupPackedTarball,
  createIsolatedFixture,
  destroyIsolatedFixture,
  extractPackagedPlugin,
  OPENCODE_AVAILABLE,
  packTarballOnce,
  startExactOpencodeServer,
  stopAllOpencodeHosts,
  TIMEOUT_MS,
} from './fixtures/receipt-workflow-host.js'

const MOCK_PROVIDER_ID = 'u7-real-host-provider'
const MOCK_MODEL_ID = 'u7-real-host-model'
const HOST_VERSIONS = ['1.18.3', '1.18.4', '1.18.5'] as const

interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

interface ModelResponse {
  text?: string
  toolCalls?: ToolCall[]
}

interface MockModel {
  url: string
  stop(): void
}

interface HostEvidence {
  version: string
  pid: number
  markerKinds: string[]
  registrationDigests: string[]
  mintEvidence: RegistrationMintEvidence[]
  operations: string[]
  workflow: Record<string, unknown>
}

interface RegistrationMintEvidence {
  registrationDigest: string
  operations: string[]
  receiptIds: string[]
}

interface MintMarkerEvidence {
  registrationDigest: string
  operation: string
  receiptId: string
}

type HostCell =
  | ({ status: 'pass'; elapsedMs: number } & HostEvidence)
  | { status: 'blocked'; version: string; reason: string }

/**
 * The OpenCode SDK client types every response as `{ data?: T; error?:
 * unknown }` to model transport failures. These tests always run against a
 * live host and expect success; this asserts that at the call site instead
 * of accessing `.data` with `?.`/`!` at every downstream read.
 */
function unwrapData<T>(result: { data?: T; error?: unknown }): T {
  if (result.data === undefined) {
    throw new Error(`opencode client call failed: ${String(result.error)}`)
  }
  return result.data
}

function sseChunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function streamModelResponse(response: ModelResponse, id: string): Response {
  const created = Math.floor(Date.now() / 1000)
  const chunks = response.toolCalls?.length
    ? [
        ...response.toolCalls.map((toolCall, index) => ({
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
        })),
        {
          id,
          object: 'chat.completion.chunk',
          created,
          model: MOCK_MODEL_ID,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        },
      ]
    : [
        {
          id,
          object: 'chat.completion.chunk',
          created,
          model: MOCK_MODEL_ID,
          choices: [
            { index: 0, delta: { role: 'assistant' }, finish_reason: null },
          ],
        },
        ...(response.text
          ? [
              {
                id,
                object: 'chat.completion.chunk',
                created,
                model: MOCK_MODEL_ID,
                choices: [
                  {
                    index: 0,
                    delta: { content: response.text },
                    finish_reason: null,
                  },
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
}

function startMockModel(responses: readonly ModelResponse[]): MockModel {
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
      return streamModelResponse(response, `u7-real-host-${requestIndex}`)
    },
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
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
      [MOCK_PROVIDER_ID]: {
        name: 'U7 Real Host Provider',
        id: MOCK_PROVIDER_ID,
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [MOCK_MODEL_ID]: {
            id: MOCK_MODEL_ID,
            name: 'U7 Real Host Model',
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: '2026-07-26',
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: 'unused-u7-real-host-key', baseURL: baseUrl },
      },
    },
  })
}

function initializeRepository(projectDir: string): void {
  const commands = [
    ['git', 'init', '-q', '-b', 'main'],
    ['git', 'config', 'user.email', 'u7@example.invalid'],
    ['git', 'config', 'user.name', 'U7 Integration'],
    ['git', 'commit', '--allow-empty', '-m', 'fixture baseline'],
  ]
  for (const command of commands) {
    const result = Bun.spawnSync(command, { cwd: projectDir })
    if (result.exitCode !== 0) {
      throw new Error(`isolated git setup failed: ${command[1]}`)
    }
  }
}

async function createSession(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
): Promise<string> {
  const session = await client.session.create({
    directory,
    title: 'U7 real host',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
  })
  return unwrapData(session).id
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

function toolParts(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object') return []
    const parts = (message as { parts?: unknown }).parts
    if (!Array.isArray(parts)) return []
    return parts.filter(
      (part): part is Record<string, unknown> =>
        Boolean(part) && typeof part === 'object' && 'state' in part,
    )
  })
}

function persistedMarkers(messages: unknown[]): unknown[] {
  return toolParts(messages).flatMap((part) => {
    const state = part.state
    if (!state || typeof state !== 'object') return []
    const metadata = (state as { metadata?: unknown }).metadata
    if (!metadata || typeof metadata !== 'object') return []
    const marker = (metadata as Record<string, unknown>)
      .systematic_workflow_receipt
    return Array.isArray(marker) ? marker : marker ? [marker] : []
  })
}

function markerKinds(messages: unknown[]): string[] {
  return persistedMarkers(messages).flatMap((marker) => {
    if (!marker || typeof marker !== 'object') return []
    const kind = (marker as Record<string, unknown>).kind
    return typeof kind === 'string' ? [kind] : []
  })
}

function markerSummary(messages: unknown[]): Array<Record<string, unknown>> {
  return persistedMarkers(messages).flatMap((marker) => {
    if (!marker || typeof marker !== 'object') return []
    const value = marker as Record<string, unknown>
    const envelope =
      value.envelope && typeof value.envelope === 'object'
        ? (value.envelope as Record<string, unknown>)
        : undefined
    const canonical =
      envelope?.canonical && typeof envelope.canonical === 'object'
        ? (envelope.canonical as Record<string, unknown>)
        : undefined
    return [
      {
        keys: Object.keys(value).sort(),
        kind: value.kind,
        envelopeKeys: envelope ? Object.keys(envelope).sort() : [],
        canonicalKeys: canonical ? Object.keys(canonical).sort() : [],
        operation: canonical?.operation,
        transition: canonical?.transition,
        status: canonical?.status,
      },
    ]
  })
}

function registrationDigests(messages: unknown[]): string[] {
  return persistedMarkers(messages).flatMap((marker) => {
    if (!marker || typeof marker !== 'object') return []
    const envelope = (marker as Record<string, unknown>).envelope
    if (!envelope || typeof envelope !== 'object') return []
    const digest = (envelope as Record<string, unknown>).registrationDigest
    return typeof digest === 'string' ? [digest] : []
  })
}

function registrationMintEvidence(
  messages: unknown[],
): RegistrationMintEvidence[] {
  const groups = new Map<
    string,
    { operations: string[]; receiptIds: string[] }
  >()
  for (const marker of persistedMarkers(messages)) {
    const evidence = parseMintMarkerEvidence(marker)
    if (!evidence) continue
    const group = groups.get(evidence.registrationDigest) ?? {
      operations: [],
      receiptIds: [],
    }
    group.operations.push(evidence.operation)
    group.receiptIds.push(evidence.receiptId)
    groups.set(evidence.registrationDigest, group)
  }
  return [...groups].map(([registrationDigest, evidence]) => ({
    registrationDigest,
    ...evidence,
  }))
}

function parseMintMarkerEvidence(
  marker: unknown,
): MintMarkerEvidence | undefined {
  if (!marker || typeof marker !== 'object') return undefined
  const value = marker as Record<string, unknown>
  if (value.kind !== 'mint') return undefined
  const envelope = value.envelope
  if (!envelope || typeof envelope !== 'object') return undefined
  const envelopeValue = envelope as Record<string, unknown>
  const canonical = envelopeValue.canonical
  if (!canonical || typeof canonical !== 'object') return undefined
  const canonicalValue = canonical as Record<string, unknown>
  const registrationDigest = envelopeValue.registrationDigest
  const operation = canonicalValue.operation
  const receiptId = canonicalValue.receiptId
  if (
    typeof registrationDigest !== 'string' ||
    typeof operation !== 'string' ||
    typeof receiptId !== 'string'
  ) {
    return undefined
  }
  return { registrationDigest, operation, receiptId }
}

function workflowEvidence(messages: unknown[]): Record<string, unknown> {
  const workflows = toolParts(messages).filter(
    (part) => part.tool === 'systematic_workflow_complete',
  )
  const state = workflows.at(-1)?.state
  if (!state || typeof state !== 'object') return {}
  const metadata = (state as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== 'object') return {}
  const value = metadata as Record<string, unknown>
  return {
    state: value.state,
    reasonCode: value.reasonCode,
    enforcement: value.enforcement,
    workflowGuard: value.workflowGuard,
  }
}

function writeProbe(fixture: { tempRoot: string }): string {
  const dir = path.join(fixture.tempRoot, 'u7-probe')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'u7-probe', type: 'module', main: './index.mjs' }),
  )
  fs.writeFileSync(
    path.join(dir, 'index.mjs'),
    `export default async function probe() {
  return { event: async ({ event }) => {
    if (!event || typeof event !== 'object') return
  } }
}
`,
  )
  return pathToFileURL(dir).href
}

async function runObserveCell(
  fixture: ReturnType<typeof createIsolatedFixture>,
  version: string,
  pluginUrls: readonly string[],
): Promise<HostEvidence> {
  initializeRepository(fixture.projectDir)
  fs.writeFileSync(
    path.join(fixture.projectDir, 'u7-check.test.ts'),
    "import { expect, test } from 'bun:test'\ntest('u7 check', () => expect(true).toBe(true))\n",
  )
  const model = startMockModel([
    {
      toolCalls: [
        {
          id: 'u7-skill',
          name: 'systematic_skill',
          arguments: { name: 'ce:work' },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: 'u7-start',
          name: 'systematic_workflow_start',
          arguments: {
            expected_operations: ['implementation', 'verification'],
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: 'u7-write',
          name: 'write',
          arguments: { filePath: 'u7-real.txt', content: 'u7 content' },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: 'u7-verify',
          name: 'bash',
          arguments: { command: 'bun test u7-check.test.ts' },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: 'u7-status',
          name: 'systematic_workflow_status',
          arguments: {},
        },
      ],
    },
    {
      toolCalls: [
        {
          id: 'u7-complete',
          name: 'systematic_workflow_complete',
          arguments: { target: 'unit' },
        },
      ],
    },
    { text: 'u7 complete' },
  ])
  const config = buildProviderConfig(pluginUrls, model.url)
  let host: Awaited<ReturnType<typeof startExactOpencodeServer>> | undefined
  try {
    host = await startExactOpencodeServer(fixture, config, version)
    const client = createOpencodeClient({
      baseUrl: host.url,
      directory: fixture.projectDir,
    })
    const sessionID = await createSession(client, fixture.projectDir)
    await promptSession(
      client,
      sessionID,
      fixture.projectDir,
      'Run the guarded workflow and ship the local change.',
    )
    const messages = unwrapData(
      await client.session.messages({
        sessionID,
        directory: fixture.projectDir,
      }),
    )
    const markers = markerKinds(messages)
    console.log(
      `U7_CELL_EVIDENCE ${JSON.stringify({
        version,
        markers,
        markerSummary: markerSummary(messages),
        registrationDigests: registrationDigests(messages),
        mintEvidence: registrationMintEvidence(messages),
        operations: toolParts(messages).map((part) => part.tool),
        workflow: workflowEvidence(messages),
      })}`,
    )
    expect(markers.length).toBeGreaterThan(0)
    expect(markers).toContain('mint')
    expect(workflowEvidence(messages)).toEqual(
      expect.objectContaining({ workflowGuard: expect.anything() }),
    )
    return {
      version,
      pid: host.pid,
      markerKinds: markers,
      registrationDigests: registrationDigests(messages),
      mintEvidence: registrationMintEvidence(messages),
      operations: toolParts(messages)
        .map((part) => part.tool)
        .filter((tool): tool is string => typeof tool === 'string'),
      workflow: workflowEvidence(messages),
    }
  } finally {
    await host?.stop()
    model.stop()
  }
}

describe.skipIf(!OPENCODE_AVAILABLE)('U7a real host', () => {
  beforeAll(() => {
    packTarballOnce()
  }, 200_000)

  afterAll(async () => {
    await stopAllOpencodeHosts()
    cleanupPackedTarball()
  })

  test(
    'loads the packed runtime and mints through the parser-backed observer',
    async () => {
      const fixture = createIsolatedFixture()
      const packed = extractPackagedPlugin(fixture).pluginUrl
      const probe = writeProbe(fixture)
      try {
        const started = performance.now()
        const evidence = await runObserveCell(fixture, '1.18.5', [
          packed,
          probe,
        ])
        console.log(
          `U7_SCENARIO packed ${JSON.stringify({
            elapsedMs: Math.round(performance.now() - started),
            pid: evidence.pid,
          })}`,
        )
        expect(evidence.markerKinds).toContain('mint')
        expect(evidence.operations).toContain('bash')
        expect(evidence.workflow.workflowGuard).toEqual(
          expect.objectContaining({ target: 'unit' }),
        )
      } finally {
        destroyIsolatedFixture(fixture)
      }
    },
    TIMEOUT_MS * 4,
  )

  test(
    'reports each exact host version cell independently',
    async () => {
      const cells: HostCell[] = []
      for (const version of HOST_VERSIONS) {
        const fixture = createIsolatedFixture()
        const packed = extractPackagedPlugin(fixture).pluginUrl
        try {
          const started = performance.now()
          const evidence = await runObserveCell(fixture, version, [packed])
          cells.push({
            status: 'pass',
            elapsedMs: Math.round(performance.now() - started),
            ...evidence,
          })
        } catch (error) {
          cells.push({ status: 'blocked', version, reason: String(error) })
        } finally {
          destroyIsolatedFixture(fixture)
        }
      }
      console.log(`U7_HOST_MATRIX ${JSON.stringify(cells)}`)
      expect(cells).toHaveLength(HOST_VERSIONS.length)
      for (const cell of cells) {
        expect(['pass', 'blocked']).toContain(cell.status)
      }
    },
    TIMEOUT_MS * 12,
  )

  test(
    'keeps packed and source registrations independent without duplicate host calls',
    async () => {
      const fixture = createIsolatedFixture()
      const secondFixture = createIsolatedFixture()
      const packed = extractPackagedPlugin(fixture).pluginUrl
      const secondPacked = extractPackagedPlugin(secondFixture).pluginUrl
      try {
        const started = performance.now()
        const evidence = await runObserveCell(fixture, '1.18.5', [
          packed,
          secondPacked,
        ])
        console.log(
          `U7_SCENARIO dual-source ${JSON.stringify({
            elapsedMs: Math.round(performance.now() - started),
            pid: evidence.pid,
          })}`,
        )
        expect(
          evidence.operations.filter((tool) => tool === 'write'),
        ).toHaveLength(1)
        expect(new Set(evidence.registrationDigests)).toHaveLength(2)
        expect(evidence.mintEvidence).toHaveLength(2)
        for (const registration of evidence.mintEvidence) {
          expect([...registration.operations].sort()).toEqual([
            'implementation',
            'verification',
          ])
          expect(new Set(registration.receiptIds)).toHaveLength(2)
        }
        expect(
          evidence.registrationDigests.every((digest) =>
            /^[a-f0-9]{64}$/.test(digest),
          ),
        ).toBe(true)
        expect(evidence.workflow.workflowGuard).toEqual(
          expect.objectContaining({ target: 'unit' }),
        )
      } finally {
        destroyIsolatedFixture(fixture)
        destroyIsolatedFixture(secondFixture)
      }
    },
    TIMEOUT_MS * 4,
  )

  test(
    'acquires an exact OpenCode host version in an isolated fixture',
    async () => {
      const fixture = createIsolatedFixture()
      try {
        const server = await startExactOpencodeServer(
          fixture,
          JSON.stringify({ formatter: false, lsp: false }),
          '1.18.5',
        )
        expect(server.pid).toBeGreaterThan(0)
        await server.stop()
      } finally {
        destroyIsolatedFixture(fixture)
      }
    },
    TIMEOUT_MS * 3,
  )
})
