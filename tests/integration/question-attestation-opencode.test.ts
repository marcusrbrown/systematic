import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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
  startOpencodeServer,
  stopAllOpencodeHosts,
  TIMEOUT_MS,
} from './fixtures/receipt-workflow-host.js'

const MOCK_PROVIDER_ID = 'u6-question-provider'
const MOCK_MODEL_ID = 'u6-question-model'

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

function sseChunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function streamResponse(
  response: ScriptedResponse,
  id: string,
  created: number,
): Response {
  const chunks =
    response.toolCalls && response.toolCalls.length > 0
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
              {
                index: 0,
                delta: response.text ? { role: 'assistant' } : {},
                finish_reason: null,
              },
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
      return streamResponse(
        response,
        `u6-question-${requestIndex}`,
        Math.floor(Date.now() / 1000),
      )
    },
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

function writeQuestionProbePlugin(fixture: IsolatedFixture): {
  url: string
  capturePath: string
} {
  const pluginDir = path.join(fixture.tempRoot, 'question-probe-plugin')
  const capturePath = path.join(fixture.tempRoot, 'question-probe-events.jsonl')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({
      name: 'question-attestation-probe',
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

function answerShape(answers) {
  return {
    outerArray: Array.isArray(answers),
    outerLength: Array.isArray(answers) ? answers.length : null,
    itemKinds: Array.isArray(answers) ? answers.map((item) => Array.isArray(item) ? 'array' : typeof item) : [],
    itemLengths: Array.isArray(answers) ? answers.map((item) => Array.isArray(item) ? item.length : null) : [],
    boundedSelections: Array.isArray(answers)
      ? answers.flatMap((item) => Array.isArray(item) ? item.map((value) => value === 'yes' || value === 'confirm' ? value : 'other') : [])
      : [],
  }
}

export default async function questionProbe() {
  append({ type: 'loaded', pid: process.pid })
  return {
    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'question') return
      const args = output.args && typeof output.args === 'object' ? output.args : {}
      const questions = Array.isArray(args.questions) ? args.questions : []
      append({
        type: 'question-before',
        callID: input.callID,
        questionCount: questions.length,
        canonicalQuestion: questions[0] && typeof questions[0] === 'object'
          ? {
              question: questions[0].question,
              header: questions[0].header,
              questionKeys: Object.keys(questions[0]).sort(),
              optionKeys:
                Array.isArray(questions[0].options) && questions[0].options[0]
                  ? Object.keys(questions[0].options[0]).sort()
                  : [],
              optionLabels: Array.isArray(questions[0].options)
                ? questions[0].options.map((option) => option && typeof option.label === 'string' ? option.label : 'other')
                : [],
            }
          : null,
      })
    },
    event: async ({ event }) => {
      if (!event || typeof event !== 'object') return
      const properties = event.properties && typeof event.properties === 'object'
        ? event.properties
        : {}
      if (event.type === 'question.asked') {
        append({
          type: 'question.asked',
          propertyKeys: Object.keys(properties).sort(),
          idType: typeof properties.id,
          sessionIDType: typeof properties.sessionID,
          questionCount: Array.isArray(properties.questions) ? properties.questions.length : null,
          toolKeys: properties.tool && typeof properties.tool === 'object' ? Object.keys(properties.tool).sort() : [],
          toolCallIDType: properties.tool && typeof properties.tool === 'object' ? typeof properties.tool.callID : 'absent',
        })
      }
      if (event.type === 'question.replied') {
        append({
          type: 'question.replied',
          propertyKeys: Object.keys(properties).sort(),
          sessionIDType: typeof properties.sessionID,
          requestIDType: typeof properties.requestID,
          answers: answerShape(properties.answers),
        })
      }
      if (event.type === 'question.rejected') {
        append({
          type: 'question.rejected',
          propertyKeys: Object.keys(properties).sort(),
          sessionIDType: typeof properties.sessionID,
          requestIDType: typeof properties.requestID,
        })
      }
    },
  }
}
`,
  )
  return { url: new URL('./', `file://${pluginDir}/`).href, capturePath }
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
        name: 'U6 Question Provider',
        id: MOCK_PROVIDER_ID,
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [MOCK_MODEL_ID]: {
            id: MOCK_MODEL_ID,
            name: 'U6 Question Model',
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
        options: { apiKey: 'unused-u6-question-key', baseURL: baseUrl },
      },
    },
  })
}

function readEvents(capturePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(capturePath)) return []
  return fs
    .readFileSync(capturePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function systemMarkers(messages: unknown[]): unknown[] {
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

function workflowParts(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object') return []
    const parts = (message as { parts?: unknown }).parts
    if (!Array.isArray(parts)) return []
    return parts.filter((part): part is Record<string, unknown> => {
      if (!part || typeof part !== 'object') return false
      const value = part as { type?: unknown; tool?: unknown; state?: unknown }
      return (
        value.type === 'tool' &&
        typeof value.tool === 'string' &&
        value.tool.startsWith('systematic_workflow_') &&
        !!value.state &&
        typeof value.state === 'object' &&
        (value.state as { status?: unknown }).status === 'completed'
      )
    })
  })
}

function summarizeParts(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object') return []
    const parts = (message as { parts?: unknown }).parts
    if (!Array.isArray(parts)) return []
    return parts.map((part) => {
      if (!part || typeof part !== 'object') return { type: null }
      const value = part as Record<string, unknown>
      const state = value.state
      return {
        type: value.type,
        tool: 'tool' in value ? value.tool : null,
        state:
          state && typeof state === 'object' && 'status' in state
            ? state.status
            : null,
        error:
          state && typeof state === 'object' && 'error' in state
            ? state.error
            : null,
      }
    })
  })
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  predicate: (value: T) => boolean,
  timeoutMs = TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined && predicate(value)) return value
    await Bun.sleep(100)
  }
  throw new Error('U6 question host condition timed out')
}

async function createSession(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
): Promise<string> {
  const created = await client.session.create({
    directory,
    title: 'U6 question attestation',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
  })
  return created.data.id
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

describe.skipIf(!OPENCODE_AVAILABLE)('OpenCode Question attestation', () => {
  beforeAll(() => {
    packTarballOnce()
  }, 200_000)

  afterAll(async () => {
    await stopAllOpencodeHosts()
    cleanupPackedTarball()
  })

  test(
    'runs the real native question ask reply and one-time consume flow',
    async () => {
      const fixture = createIsolatedFixture()
      const probe = writeQuestionProbePlugin(fixture)
      const packagedPlugin = extractPackagedPlugin(fixture).pluginUrl
      const model = startMockModelServer([
        {
          toolCalls: [
            {
              id: 'u6-skill',
              name: 'systematic_skill',
              arguments: { name: 'ce:work' },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: 'u6-start',
              name: 'systematic_workflow_start',
              arguments: {},
            },
          ],
        },
        {
          toolCalls: [
            {
              id: 'u6-complete-veto',
              name: 'systematic_workflow_complete',
              arguments: { target: 'unit' },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: 'u6-question',
              name: 'question',
              arguments: {
                questions: [
                  {
                    header: 'Confirm',
                    question: 'wrong',
                    options: [],
                  },
                ],
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: 'u6-write',
              name: 'write',
              arguments: {
                filePath: 'question-attestation.txt',
                content: 'bounded-question-operation',
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: 'u6-complete-consume',
              name: 'systematic_workflow_complete',
              arguments: { target: 'unit' },
            },
          ],
        },
        { text: 'done' },
      ])
      const config = buildProviderConfig([packagedPlugin, probe.url], model.url)
      const host = await startOpencodeServer(fixture, config)
      try {
        const client = createOpencodeClient({
          baseUrl: host.url,
          directory: fixture.projectDir,
        })
        const sessionID = await createSession(client, fixture.projectDir)
        const prompt = promptSession(
          client,
          sessionID,
          fixture.projectDir,
          'Run the guarded workflow and complete the unit.',
        )

        let pending: Awaited<ReturnType<typeof client.question.list>>['data']
        try {
          pending = await waitFor(
            async () => {
              const response = await client.question.list({
                directory: fixture.projectDir,
              })
              return response.data.filter(
                (request) => request.sessionID === sessionID,
              )
            },
            (requests) => requests.length === 1,
          )
        } catch {
          const globalQuestions = await client.question.list({
            directory: fixture.projectDir,
          })
          const messages = await client.session.messages({
            sessionID,
            directory: fixture.projectDir,
          })
          throw new Error(
            `U6_PENDING ${JSON.stringify({
              events: readEvents(probe.capturePath),
              globalQuestionCount: globalQuestions.data.length,
              parts: summarizeParts(messages.data),
            })}`,
          )
        }
        const request = pending[0]
        expect(request).toBeDefined()
        if (!request) throw new Error('question request missing')

        const eventsBeforeReply = readEvents(probe.capturePath)
        const asked = eventsBeforeReply.find(
          (event) => event.type === 'question.asked',
        )
        expect(asked).toMatchObject({
          propertyKeys: ['id', 'questions', 'sessionID', 'tool'],
          idType: 'string',
          sessionIDType: 'string',
          toolCallIDType: 'string',
        })
        const questionBefore = eventsBeforeReply.find(
          (event) => event.type === 'question-before',
        )
        expect(questionBefore).toMatchObject({
          questionCount: 1,
          canonicalQuestion: {
            question: 'Confirm the requested guarded transition.',
            header: 'Confirm',
            questionKeys: ['header', 'options', 'question'],
            optionKeys: ['description', 'label'],
            optionLabels: ['yes', 'no'],
          },
        })

        await client.question.reply({
          requestID: request.id,
          directory: fixture.projectDir,
          answers: [['yes']],
        })
        await waitFor(
          async () => readEvents(probe.capturePath),
          (events) => events.some((event) => event.type === 'question.replied'),
        )

        const replied = readEvents(probe.capturePath).find(
          (event) => event.type === 'question.replied',
        )
        expect(replied).toMatchObject({
          propertyKeys: ['answers', 'requestID', 'sessionID'],
          sessionIDType: 'string',
          requestIDType: 'string',
          answers: {
            outerArray: true,
            outerLength: 1,
            itemKinds: ['array'],
            itemLengths: [1],
            boundedSelections: ['yes'],
          },
        })
        const askedIndex = readEvents(probe.capturePath).findIndex(
          (event) => event.type === 'question.asked',
        )
        const repliedIndex = readEvents(probe.capturePath).findIndex(
          (event) => event.type === 'question.replied',
        )
        expect(askedIndex).toBeGreaterThanOrEqual(0)
        expect(repliedIndex).toBeGreaterThan(askedIndex)

        await prompt
        const messages = (
          await client.session.messages({
            sessionID,
            directory: fixture.projectDir,
          })
        ).data
        const markers = systemMarkers(messages)
        expect(markers.length).toBeGreaterThan(0)
        expect(JSON.stringify(markers)).not.toContain('wrong')
        expect(JSON.stringify(markers)).not.toContain(
          'bounded-question-operation',
        )
        const workflow = workflowParts(messages)
        const completion = workflow.at(-1)
        const completionState = completion?.state as Record<string, unknown>
        const completionMetadata = completionState.metadata as Record<
          string,
          unknown
        >
        expect(completionMetadata.questionAttestation).toMatchObject({
          status: 'attested',
          consumption: 'consumed',
          requestId: expect.any(String),
        })
        expect(completionMetadata.state).toBe('unavailable')
        expect(completionMetadata.reasonCode).toBe('guard-unavailable')
        const eventsBeforeReplay = readEvents(probe.capturePath).filter(
          (event) => event.type === 'question.replied',
        ).length
        await client.question.reply({
          requestID: request.id,
          directory: fixture.projectDir,
          answers: [['yes']],
        })
        const eventsAfterReplay = readEvents(probe.capturePath).filter(
          (event) => event.type === 'question.replied',
        ).length
        expect(eventsAfterReplay).toBe(eventsBeforeReplay)
      } finally {
        await host.stop()
        model.stop()
        destroyIsolatedFixture(fixture)
      }
    },
    TIMEOUT_MS * 3,
  )

  test(
    'rejects a real native question without minting attestation',
    async () => {
      const fixture = createIsolatedFixture()
      const probe = writeQuestionProbePlugin(fixture)
      const packagedPlugin = extractPackagedPlugin(fixture).pluginUrl
      const model = startMockModelServer([
        {
          toolCalls: [
            {
              id: 'u6-reject-skill',
              name: 'systematic_skill',
              arguments: { name: 'ce:work' },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: 'u6-reject-complete',
              name: 'systematic_workflow_complete',
              arguments: { target: 'unit' },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: 'u6-reject-question',
              name: 'question',
              arguments: {
                questions: [
                  {
                    header: 'Confirm',
                    question: 'wrong',
                    options: [],
                  },
                ],
              },
            },
          ],
        },
        { text: 'declined' },
      ])
      const config = buildProviderConfig([packagedPlugin, probe.url], model.url)
      const host = await startOpencodeServer(fixture, config)
      try {
        const client = createOpencodeClient({
          baseUrl: host.url,
          directory: fixture.projectDir,
        })
        const sessionID = await createSession(client, fixture.projectDir)
        const prompt = promptSession(
          client,
          sessionID,
          fixture.projectDir,
          'Ask for guarded confirmation, then wait.',
        )
        const pending = await waitFor(
          async () => {
            const response = await client.question.list({
              directory: fixture.projectDir,
            })
            return response.data.filter(
              (request) => request.sessionID === sessionID,
            )
          },
          (requests) => requests.length === 1,
        )
        const request = pending[0]
        expect(request).toBeDefined()
        if (!request) throw new Error('question request missing')
        await client.question.reject({
          requestID: request.id,
          directory: fixture.projectDir,
        })
        await prompt

        const replied = readEvents(probe.capturePath).find(
          (event) => event.type === 'question.rejected',
        )
        expect(replied).toMatchObject({
          propertyKeys: ['requestID', 'sessionID'],
          requestIDType: 'string',
          sessionIDType: 'string',
        })
        const messages = (
          await client.session.messages({
            sessionID,
            directory: fixture.projectDir,
          })
        ).data
        const serializedMarkers = JSON.stringify(systemMarkers(messages))
        expect(serializedMarkers).not.toContain('attested')
        expect(serializedMarkers).not.toContain('declined')
        const rejectedWorkflowParts = workflowParts(messages).filter(
          (part) => part.tool === 'systematic_workflow_complete',
        )
        expect(rejectedWorkflowParts.length).toBeGreaterThan(0)
        const lastCompletePart = rejectedWorkflowParts.at(-1)
        const lastCompleteState = lastCompletePart?.state as Record<
          string,
          unknown
        >
        const lastCompleteMetadata = lastCompleteState?.metadata as Record<
          string,
          unknown
        >
        // The guard must NOT have satisfied the transition; state must be non-completed
        expect(lastCompleteMetadata?.state).not.toBe('completed')
        // The questionAttestation field must be present but NOT show 'attested'
        const attestation = lastCompleteMetadata?.questionAttestation as
          | Record<string, unknown>
          | undefined
        if (attestation !== undefined) {
          expect(attestation.status).not.toBe('attested')
        }
      } finally {
        await host.stop()
        model.stop()
        destroyIsolatedFixture(fixture)
      }
    },
    TIMEOUT_MS * 3,
  )

  test(
    'does not treat ordinary user text as Question evidence',
    async () => {
      const fixture = createIsolatedFixture()
      const probe = writeQuestionProbePlugin(fixture)
      const packagedPlugin = extractPackagedPlugin(fixture).pluginUrl
      const model = startMockModelServer([{ text: 'acknowledged' }])
      const config = buildProviderConfig([packagedPlugin, probe.url], model.url)
      const host = await startOpencodeServer(fixture, config)
      try {
        const client = createOpencodeClient({
          baseUrl: host.url,
          directory: fixture.projectDir,
        })
        const sessionID = await createSession(client, fixture.projectDir)
        await promptSession(client, sessionID, fixture.projectDir, 'yes')
        const messages = (
          await client.session.messages({
            sessionID,
            directory: fixture.projectDir,
          })
        ).data
        const serialized = JSON.stringify(messages)
        expect(serialized).not.toContain('questionAttestation')
        expect(
          readEvents(probe.capturePath).some(
            (event) => event.type === 'question.replied',
          ),
        ).toBe(false)
      } finally {
        await host.stop()
        model.stop()
        destroyIsolatedFixture(fixture)
      }
    },
    TIMEOUT_MS * 2,
  )

  test(
    'disables one session only after affirmative native confirmation',
    async () => {
      const fixture = createIsolatedFixture()
      const probe = writeQuestionProbePlugin(fixture)
      const packagedPlugin = extractPackagedPlugin(fixture).pluginUrl
      const model = startMockModelServer([
        {
          toolCalls: [
            {
              id: 'u6-disable-skill',
              name: 'systematic_skill',
              arguments: { name: 'ce:work' },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: 'u6-disable-request',
              name: 'systematic_workflow_control',
              arguments: { mode: 'disabled' },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: 'u6-disable-question',
              name: 'question',
              arguments: {
                questions: [
                  {
                    header: 'Confirm',
                    question: 'wrong',
                    options: [],
                  },
                ],
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: 'u6-disable-consume',
              name: 'systematic_workflow_control',
              arguments: { mode: 'disabled' },
            },
          ],
        },
        { text: 'disabled' },
      ])
      const config = buildProviderConfig([packagedPlugin, probe.url], model.url)
      const host = await startOpencodeServer(fixture, config)
      try {
        const client = createOpencodeClient({
          baseUrl: host.url,
          directory: fixture.projectDir,
        })
        const sessionID = await createSession(client, fixture.projectDir)
        const prompt = promptSession(
          client,
          sessionID,
          fixture.projectDir,
          'Request session disablement after confirmation.',
        )
        const pending = await waitFor(
          async () => {
            const response = await client.question.list({
              directory: fixture.projectDir,
            })
            return response.data.filter(
              (request) => request.sessionID === sessionID,
            )
          },
          (requests) => requests.length === 1,
        )
        const request = pending[0]
        expect(request).toBeDefined()
        if (!request) throw new Error('disablement question missing')
        const beforeReply = (
          await client.session.messages({
            sessionID,
            directory: fixture.projectDir,
          })
        ).data
        expect(JSON.stringify(beforeReply)).toContain('question-attestation')
        expect(JSON.stringify(beforeReply)).not.toContain('"state":"disabled"')

        await client.question.reply({
          requestID: request.id,
          directory: fixture.projectDir,
          answers: [['confirm']],
        })
        await prompt
        const afterReply = (
          await client.session.messages({
            sessionID,
            directory: fixture.projectDir,
          })
        ).data
        const controlParts = workflowParts(afterReply).filter(
          (part) => part.tool === 'systematic_workflow_control',
        )
        expect(controlParts.at(-1)?.state).toMatchObject({
          status: 'completed',
          metadata: { state: 'disabled' },
        })
      } finally {
        await host.stop()
        model.stop()
        destroyIsolatedFixture(fixture)
      }
    },
    TIMEOUT_MS * 3,
  )
})
