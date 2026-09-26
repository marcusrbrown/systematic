// Real-host characterization of what actually reaches the model provider
// when `systematic_skill` (or a discovered project skill's slash command) is
// invoked: the assertions in this file read the mock provider's own INBOUND
// HTTP request bodies -- the literal `content` field of the `role: "tool"` /
// `role: "user"` chat-completion message the model would receive -- rather
// than the host's `session.messages()` readback, so what is asserted is
// exactly what the wire carries.
//
// Six scenarios (a-f), matching the "skill-delivery" verification plan:
//   a) a small bundled skill (well under any truncation threshold) --
//      its final body line reaches the provider verbatim.
//   b) `ce:review` (skills/ce-review/SKILL.md, ~71KB, wrapped output >50KiB)
//      with no `tool_output` config override -- the host truncates the raw
//      tool result by default, but `restoreSkillOutput` (src/lib/skill-tool.ts)
//      puts the full content back before the next provider turn, so no
//      truncation marker and the final body line both reach the provider.
//   c) an explicit `tool_output: { max_bytes }` / `{ max_lines }` host config
//      override -- `restoreSkillOutput` deliberately backs off whenever the
//      user has set either limit (src/index.ts's `userOutputLimitSet`), so
//      the provider sees the host's own truncated preview and marker.
//   d) `arguments` substitution on `ce:work` (its body contains a literal
//      `<input_document> #$ARGUMENTS </input_document>` line) -- supplying
//      `arguments` substitutes it before the provider sees it; omitting it
//      leaves the literal `$ARGUMENTS` placeholder.
//   e) a discovered (non-bundled) project skill's slash command, body >50KiB
//      with a unique tail sentinel and its own `$ARGUMENTS` line, invoked
//      with an argument -- proves `wrapSkillTemplate`'s full-body inlining
//      (src/lib/config-handler.ts's `loadDiscoveredSkillAsCommand`) neither
//      truncates nor drops the tail, and OpenCode's own command-argument
//      substitution still reaches the provider.
//   f) loading a guarded skill (`ce:plan`, >32KB) activates its epoch --
//      observed via the `systematic_workflow_receipt` progression marker the
//      workflow guard merges directly into the `systematic_skill` tool
//      part's own `state.metadata` (src/lib/opencode-workflow-guard.ts's
//      `finishSkill`/`mergeProgressionMarker`). This is host-side metadata,
//      never sent to the provider, so it is read back via
//      `session.messages()` rather than a captured request body -- the only
//      scenario in this file that does.
//
// Process hygiene: this file is invoked directly, never through the full
// suite, per the pgrep/bun-test/comm sequence documented for real-host
// integration files in this repo. See
// tests/integration/skill-command-probe.test.ts and
// tests/integration/receipt-workflow-guard-real-host.test.ts for the shared
// server + SDK client + mock OpenAI-compatible provider wiring this test
// adapts.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'

import { requireOpencodeAvailable } from '../../scripts/lib/opencode-availability.js'
import {
  cleanupPackedTarball,
  createIsolatedFixture,
  destroyIsolatedFixture,
  extractPackagedPlugin,
  getOpencodeAvailability,
  type IsolatedFixture,
  isOpencodeAvailable,
  opencodeAvailabilityReason,
  packTarballOnce,
  scriptedResponseChunks,
  startOpencodeServer,
  stopAllOpencodeHosts,
  TIMEOUT_MS,
} from './fixtures/receipt-workflow-host.js'

requireOpencodeAvailable(getOpencodeAvailability())
if (!isOpencodeAvailable()) {
  console.warn(
    `[systematic] skipping OpenCode-dependent tests in skill-delivery.test.ts: ${opencodeAvailabilityReason()}`,
  )
}

const MOCK_PROVIDER_ID = 'skill-delivery-provider'
const MOCK_MODEL_ID = 'skill-delivery-model'

/** The host's own truncation marker (see src/lib/skill-tool.ts's `TRUNCATION_MARKER_RE`). */
const TRUNCATION_MARKER = 'truncated...'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sseChunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function buildProviderConfig(
  pluginUrls: readonly string[],
  baseUrl: string,
  toolOutput?: { max_bytes?: number; max_lines?: number },
): string {
  return JSON.stringify({
    formatter: false,
    lsp: false,
    plugin: pluginUrls,
    ...(toolOutput ? { tool_output: toolOutput } : {}),
    provider: {
      [MOCK_PROVIDER_ID]: {
        name: 'Skill Delivery Provider',
        id: MOCK_PROVIDER_ID,
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [MOCK_MODEL_ID]: {
            id: MOCK_MODEL_ID,
            name: 'Skill Delivery Model',
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: '2026-09-25',
            limit: { context: 200_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: 'unused-skill-delivery-key', baseURL: baseUrl },
      },
    },
  })
}

interface ScriptedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

interface ScriptedStep {
  toolCalls?: ScriptedToolCall[]
  text?: string
}

interface ScriptedModel {
  url: string
  stop(): void
  /** Every inbound chat-completion request body, in arrival order. */
  requests: Record<string, unknown>[]
}

/**
 * A local OpenAI-compatible provider that captures every inbound request
 * body and advances through `steps` only for requests that carry a
 * non-empty `tools` array -- the background title-generation turn (which
 * carries `tools: {}`, an object rather than an array) never consumes a
 * step, matching `startScriptedSkillModelServer`'s documented dispatch
 * strategy in fixtures/receipt-workflow-host.ts.
 */
function startScriptedModel(steps: readonly ScriptedStep[]): ScriptedModel {
  let stepIndex = 0
  const requests: Record<string, unknown>[] = []
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
      const body = isRecord(rawBody) ? rawBody : {}
      requests.push(body)
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0
      const response: ScriptedStep = hasTools
        ? (steps[stepIndex++] ?? { text: '' })
        : { text: 'skill-delivery title probe' }
      const chunks = scriptedResponseChunks(
        response,
        `skill-delivery-${requests.length}`,
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
    requests,
  }
}

/** A single message's tool-result content, or `undefined` if `message` is
 * not the `role: "tool"` message for `toolCallId`. */
function matchingToolResultContent(
  message: unknown,
  toolCallId: string,
): string | undefined {
  if (!isRecord(message)) return undefined
  if (message.role !== 'tool') return undefined
  if (message.tool_call_id !== toolCallId) return undefined
  return typeof message.content === 'string' ? message.content : undefined
}

/**
 * Finds the `role: "tool"` message content for a given `tool_call_id`
 * across every captured request -- this is exactly the tool result text
 * the model provider receives on the turn following the tool call.
 */
function toolResultContent(
  requests: readonly Record<string, unknown>[],
  toolCallId: string,
): string {
  for (const body of requests) {
    const messages = body.messages
    if (!Array.isArray(messages)) continue
    for (const message of messages) {
      const content = matchingToolResultContent(message, toolCallId)
      if (content !== undefined) return content
    }
  }
  throw new Error(
    `no captured request carried a tool-result message for tool_call_id ${toolCallId}`,
  )
}

/** The single `role: "user"` message content in the first captured request
 * -- the fully assembled slash-command text OpenCode sends on the one
 * chat turn a `session.command()` call with no scripted tool call produces. */
function firstUserMessageContent(
  requests: readonly Record<string, unknown>[],
): string {
  const [first] = requests
  if (!first) throw new Error('no request was captured')
  const messages = first.messages
  if (!Array.isArray(messages)) {
    throw new Error('captured request carried no messages array')
  }
  for (const message of messages) {
    if (isRecord(message) && message.role === 'user') {
      if (typeof message.content === 'string') return message.content
    }
  }
  throw new Error('captured request carried no user-role message')
}

async function createAllowAllSession(
  client: ReturnType<typeof createOpencodeClient>,
  fixture: IsolatedFixture,
  title: string,
): Promise<string> {
  const created = await client.session.create({
    directory: fixture.projectDir,
    title,
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
  })
  if (created.data === undefined) {
    throw new Error(
      `session create failed for ${title}: ${JSON.stringify(created.error)}`,
    )
  }
  return created.data.id
}

function initializeRepository(projectDir: string): void {
  const commands = [
    ['git', 'init', '-q', '-b', 'main'],
    ['git', 'config', 'user.email', 'skill-delivery@example.invalid'],
    ['git', 'config', 'user.name', 'Skill Delivery Integration'],
    ['git', 'commit', '--allow-empty', '-m', 'fixture baseline'],
  ]
  for (const command of commands) {
    const result = Bun.spawnSync(command, { cwd: projectDir })
    if (result.exitCode !== 0) {
      throw new Error(`isolated git setup failed: ${command.join(' ')}`)
    }
  }
}

// --- Bundled-skill fixtures (real, packaged content -- never hand-written) ---

/** skills/git-clean-gone-branches/SKILL.md is 67 lines / ~2.6KB: well under
 * any truncation threshold this file exercises. */
const SMALL_SKILL_NAME = 'git-clean-gone-branches'
const SMALL_SKILL_FINAL_LINE =
  'If the user declines, acknowledge and stop without deleting anything.'

/** skills/ce-review/SKILL.md is ~71.5KB raw (wrapped output >50KiB, the
 * host's default byte-truncation threshold), 798 lines (under the default
 * 2000-line threshold). */
const CE_REVIEW_NAME = 'ce:review'
const CE_REVIEW_FINAL_LINE = '@./references/review-output-template.md'

/** skills/ce-plan/SKILL.md is ~63KB, over the workflow guard's 32KB
 * (`MAX_HOST_OUTPUT_LENGTH`) skill-activation threshold. */
const CE_PLAN_NAME = 'ce:plan'

/** skills/ce-work/SKILL.md line 17 is exactly
 * `<input_document> #$ARGUMENTS </input_document>`. */
const CE_WORK_NAME = 'ce:work'
const CE_WORK_ARG_SENTINEL = 'SKILL_DELIVERY_ARG_SENTINEL_9F3B21'

describe.skipIf(!isOpencodeAvailable())(
  'systematic_skill delivery — real OpenCode host, provider-visible content',
  () => {
    beforeAll(() => {
      packTarballOnce()
    }, 200_000)

    afterAll(async () => {
      await stopAllOpencodeHosts()
      cleanupPackedTarball()
    })

    test(
      'a) a small bundled skill delivers its final body line to the provider, unmodified',
      async () => {
        const fixture: IsolatedFixture = createIsolatedFixture()
        const packaged = extractPackagedPlugin(fixture)
        const model = startScriptedModel([
          {
            toolCalls: [
              {
                id: 'small-skill-call',
                name: 'systematic_skill',
                arguments: { name: SMALL_SKILL_NAME },
              },
            ],
          },
          { text: 'done' },
        ])
        const host = await startOpencodeServer(
          fixture,
          buildProviderConfig([packaged.pluginUrl], model.url),
        )
        try {
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: fixture.projectDir,
          })
          const sessionID = await createAllowAllSession(
            client,
            fixture,
            'skill-delivery a',
          )
          await client.session.prompt({
            sessionID,
            directory: fixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [{ type: 'text', text: 'Load the requested skill.' }],
          })
          const content = toolResultContent(model.requests, 'small-skill-call')
          console.log(
            `SKILL_DELIVERY_A ${JSON.stringify({ contentBytes: Buffer.byteLength(content, 'utf8') })}`,
          )
          expect(content).toContain(SMALL_SKILL_FINAL_LINE)
          expect(content).not.toContain(TRUNCATION_MARKER)
        } finally {
          await host.stop()
          model.stop()
          destroyIsolatedFixture(fixture)
        }
      },
      TIMEOUT_MS * 3,
    )

    test(
      'b) ce:review (>50KiB wrapped) reaches the provider fully restored, with no truncation marker',
      async () => {
        const fixture: IsolatedFixture = createIsolatedFixture()
        const packaged = extractPackagedPlugin(fixture)
        const skillBytes = fs.statSync(
          path.join(packaged.packageDir, 'skills/ce-review/SKILL.md'),
        ).size
        const model = startScriptedModel([
          {
            toolCalls: [
              {
                id: 'ce-review-call',
                name: 'systematic_skill',
                arguments: { name: CE_REVIEW_NAME },
              },
            ],
          },
          { text: 'done' },
        ])
        const host = await startOpencodeServer(
          fixture,
          buildProviderConfig([packaged.pluginUrl], model.url),
        )
        try {
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: fixture.projectDir,
          })
          const sessionID = await createAllowAllSession(
            client,
            fixture,
            'skill-delivery b',
          )
          await client.session.prompt({
            sessionID,
            directory: fixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [{ type: 'text', text: 'Load the requested skill.' }],
          })
          const content = toolResultContent(model.requests, 'ce-review-call')
          console.log(
            `SKILL_DELIVERY_B ${JSON.stringify({
              skillFileBytes: skillBytes,
              providerVisibleBytes: Buffer.byteLength(content, 'utf8'),
            })}`,
          )
          // The wrapped output is larger than the raw file (wrapper prose,
          // base-directory line, sampled file list), so this is a lower
          // bound: proof the restore did not silently keep only a partial
          // (still-truncated) preview.
          expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(skillBytes)
          expect(content).toContain(CE_REVIEW_FINAL_LINE)
          expect(content).not.toContain(TRUNCATION_MARKER)
        } finally {
          await host.stop()
          model.stop()
          destroyIsolatedFixture(fixture)
        }
      },
      TIMEOUT_MS * 3,
    )

    test(
      'c) an explicit tool_output override disables restoration: the provider sees the host truncation marker',
      async () => {
        const fixture: IsolatedFixture = createIsolatedFixture()
        const packaged = extractPackagedPlugin(fixture)

        // -- max_bytes cell --
        const bytesModel = startScriptedModel([
          {
            toolCalls: [
              {
                id: 'ce-review-max-bytes-call',
                name: 'systematic_skill',
                arguments: { name: CE_REVIEW_NAME },
              },
            ],
          },
          { text: 'done' },
        ])
        const bytesHost = await startOpencodeServer(
          fixture,
          buildProviderConfig([packaged.pluginUrl], bytesModel.url, {
            max_bytes: 51200,
          }),
        )
        try {
          const client = createOpencodeClient({
            baseUrl: bytesHost.url,
            directory: fixture.projectDir,
          })
          const sessionID = await createAllowAllSession(
            client,
            fixture,
            'skill-delivery c max_bytes',
          )
          await client.session.prompt({
            sessionID,
            directory: fixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [{ type: 'text', text: 'Load the requested skill.' }],
          })
          const content = toolResultContent(
            bytesModel.requests,
            'ce-review-max-bytes-call',
          )
          console.log(
            `SKILL_DELIVERY_C_MAX_BYTES ${JSON.stringify({ contentBytes: Buffer.byteLength(content, 'utf8') })}`,
          )
          expect(content).toContain(TRUNCATION_MARKER)
          expect(content).not.toContain(CE_REVIEW_FINAL_LINE)
        } finally {
          await bytesHost.stop()
          bytesModel.stop()
        }

        // -- max_lines cell: no bundled skill exceeds 2000 lines, so a
        // deliberately small max_lines forces truncation on ce:review
        // (798 lines) instead. --
        const linesModel = startScriptedModel([
          {
            toolCalls: [
              {
                id: 'ce-review-max-lines-call',
                name: 'systematic_skill',
                arguments: { name: CE_REVIEW_NAME },
              },
            ],
          },
          { text: 'done' },
        ])
        const linesHost = await startOpencodeServer(
          fixture,
          buildProviderConfig([packaged.pluginUrl], linesModel.url, {
            max_lines: 100,
          }),
        )
        try {
          const client = createOpencodeClient({
            baseUrl: linesHost.url,
            directory: fixture.projectDir,
          })
          const sessionID = await createAllowAllSession(
            client,
            fixture,
            'skill-delivery c max_lines',
          )
          await client.session.prompt({
            sessionID,
            directory: fixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [{ type: 'text', text: 'Load the requested skill.' }],
          })
          const content = toolResultContent(
            linesModel.requests,
            'ce-review-max-lines-call',
          )
          console.log(
            `SKILL_DELIVERY_C_MAX_LINES ${JSON.stringify({ contentBytes: Buffer.byteLength(content, 'utf8') })}`,
          )
          expect(content).toContain(TRUNCATION_MARKER)
          expect(content).not.toContain(CE_REVIEW_FINAL_LINE)
        } finally {
          await linesHost.stop()
          linesModel.stop()
          destroyIsolatedFixture(fixture)
        }
      },
      TIMEOUT_MS * 5,
    )

    test(
      'd) systematic_skill `arguments` substitutes $ARGUMENTS on ce:work; omitting it leaves the literal placeholder',
      async () => {
        const fixture: IsolatedFixture = createIsolatedFixture()
        const packaged = extractPackagedPlugin(fixture)

        // -- with arguments supplied --
        const withArgsModel = startScriptedModel([
          {
            toolCalls: [
              {
                id: 'ce-work-with-args-call',
                name: 'systematic_skill',
                arguments: {
                  name: CE_WORK_NAME,
                  arguments: CE_WORK_ARG_SENTINEL,
                },
              },
            ],
          },
          { text: 'done' },
        ])
        const withArgsHost = await startOpencodeServer(
          fixture,
          buildProviderConfig([packaged.pluginUrl], withArgsModel.url),
        )
        try {
          const client = createOpencodeClient({
            baseUrl: withArgsHost.url,
            directory: fixture.projectDir,
          })
          const sessionID = await createAllowAllSession(
            client,
            fixture,
            'skill-delivery d with-arguments',
          )
          await client.session.prompt({
            sessionID,
            directory: fixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [{ type: 'text', text: 'Load the requested skill.' }],
          })
          const content = toolResultContent(
            withArgsModel.requests,
            'ce-work-with-args-call',
          )
          expect(content).toContain(
            `<input_document> #${CE_WORK_ARG_SENTINEL} </input_document>`,
          )
          expect(content).not.toContain('#$ARGUMENTS')
        } finally {
          await withArgsHost.stop()
          withArgsModel.stop()
        }

        // -- arguments omitted: the literal placeholder stays --
        const omittedModel = startScriptedModel([
          {
            toolCalls: [
              {
                id: 'ce-work-omitted-args-call',
                name: 'systematic_skill',
                arguments: { name: CE_WORK_NAME },
              },
            ],
          },
          { text: 'done' },
        ])
        const omittedHost = await startOpencodeServer(
          fixture,
          buildProviderConfig([packaged.pluginUrl], omittedModel.url),
        )
        try {
          const client = createOpencodeClient({
            baseUrl: omittedHost.url,
            directory: fixture.projectDir,
          })
          const sessionID = await createAllowAllSession(
            client,
            fixture,
            'skill-delivery d omitted-arguments',
          )
          await client.session.prompt({
            sessionID,
            directory: fixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [{ type: 'text', text: 'Load the requested skill.' }],
          })
          const content = toolResultContent(
            omittedModel.requests,
            'ce-work-omitted-args-call',
          )
          expect(content).toContain(
            '<input_document> #$ARGUMENTS </input_document>',
          )
        } finally {
          await omittedHost.stop()
          omittedModel.stop()
          destroyIsolatedFixture(fixture)
        }
      },
      TIMEOUT_MS * 5,
    )

    test(
      'e) a discovered project skill slash command (>50KiB, unique tail sentinel, $ARGUMENTS) delivers both to the provider',
      async () => {
        const fixture: IsolatedFixture = createIsolatedFixture()
        const packaged = extractPackagedPlugin(fixture)
        const skillRoot = path.join(fixture.configDir, 'skill')
        fs.mkdirSync(path.join(skillRoot, 'big-project-skill'), {
          recursive: true,
        })
        const filler = 'x'.repeat(200)
        const fillerLines = Array.from(
          { length: 300 },
          (_unused, i) => `filler line ${i}: ${filler}`,
        )
        const tailSentinel = 'SKILL_DELIVERY_TAIL_SENTINEL_4E7C10'
        const argSentinel = 'SKILL_DELIVERY_CMD_ARG_SENTINEL_1A2B3C'
        const skillPath = path.join(skillRoot, 'big-project-skill', 'SKILL.md')
        fs.writeFileSync(
          skillPath,
          [
            '---',
            'name: big-project-skill',
            'description: Large discovered project skill for skill-delivery size/argument checks',
            '---',
            'Big project skill body.',
            '',
            ...fillerLines,
            '',
            '$ARGUMENTS',
            '',
            tailSentinel,
            '',
          ].join('\n'),
        )
        const skillBytes = fs.statSync(skillPath).size
        expect(skillBytes).toBeGreaterThan(51200)

        const model = startScriptedModel([{ text: 'done' }])
        const host = await startOpencodeServer(
          fixture,
          buildProviderConfig([packaged.pluginUrl], model.url),
        )
        try {
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: fixture.projectDir,
          })
          const sessionID = await createAllowAllSession(
            client,
            fixture,
            'skill-delivery e',
          )
          const result = await client.session.command({
            sessionID,
            directory: fixture.projectDir,
            command: 'big-project-skill',
            arguments: argSentinel,
            model: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
          })
          if (result.data === undefined) {
            throw new Error(
              `session command failed: ${JSON.stringify(result.error)}`,
            )
          }
          const content = firstUserMessageContent(model.requests)
          console.log(
            `SKILL_DELIVERY_E ${JSON.stringify({
              skillFileBytes: skillBytes,
              providerVisibleBytes: Buffer.byteLength(content, 'utf8'),
            })}`,
          )
          expect(content).toContain(tailSentinel)
          expect(content).toContain(argSentinel)
        } finally {
          await host.stop()
          model.stop()
          destroyIsolatedFixture(fixture)
        }
      },
      TIMEOUT_MS * 3,
    )

    test(
      'f) loading a guarded skill over 32KB activates its epoch, observed via the progression marker merged into the tool part metadata',
      async () => {
        const fixture: IsolatedFixture = createIsolatedFixture()
        initializeRepository(fixture.projectDir)
        const packaged = extractPackagedPlugin(fixture)
        const model = startScriptedModel([
          {
            toolCalls: [
              {
                id: 'ce-plan-guard-call',
                name: 'systematic_skill',
                arguments: { name: CE_PLAN_NAME },
              },
            ],
          },
          { text: 'done' },
        ])
        const host = await startOpencodeServer(
          fixture,
          buildProviderConfig([packaged.pluginUrl], model.url),
        )
        try {
          const client = createOpencodeClient({
            baseUrl: host.url,
            directory: fixture.projectDir,
          })
          const sessionID = await createAllowAllSession(
            client,
            fixture,
            'skill-delivery f',
          )
          await client.session.prompt({
            sessionID,
            directory: fixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [{ type: 'text', text: 'Load the requested skill.' }],
          })

          const messagesResult = await client.session.messages({
            sessionID,
            directory: fixture.projectDir,
          })
          if (messagesResult.data === undefined) {
            throw new Error(
              `session messages failed: ${JSON.stringify(messagesResult.error)}`,
            )
          }
          const messages = messagesResult.data as unknown[]
          const skillParts = messages.flatMap((message) => {
            if (!isRecord(message) || !Array.isArray(message.parts)) return []
            return message.parts.filter(
              (part): part is Record<string, unknown> =>
                isRecord(part) && part.tool === 'systematic_skill',
            )
          })
          expect(skillParts).toHaveLength(1)
          const [skillPart] = skillParts
          if (!skillPart)
            throw new Error('unreachable: skillParts checked above')
          const state = isRecord(skillPart.state) ? skillPart.state : {}
          const metadata = isRecord(state.metadata) ? state.metadata : {}
          const markers = metadata.systematic_workflow_receipt
          const markerArray = Array.isArray(markers)
            ? markers
            : markers
              ? [markers]
              : []
          const epochMarker = markerArray.find(
            (marker): marker is Record<string, unknown> =>
              isRecord(marker) &&
              marker.kind === 'control' &&
              marker.control === 'progression' &&
              marker.target === 'epoch' &&
              marker.state === 'started',
          )
          console.log(
            `SKILL_DELIVERY_F ${JSON.stringify({
              markerCount: markerArray.length,
              epochMarkerPresent: epochMarker !== undefined,
              epochFamily: epochMarker?.family,
            })}`,
          )
          expect(epochMarker).toBeDefined()
        } finally {
          await host.stop()
          model.stop()
          destroyIsolatedFixture(fixture)
        }
      },
      TIMEOUT_MS * 3,
    )
  },
)
