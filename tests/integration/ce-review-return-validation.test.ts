// U5 real-host scenario: prove a real OpenCode scripted host loads the
// packaged `ce:review` skill content and then invokes the packaged
// `skills/ce-review/scripts/validate-review.mjs` helper's `return` subcommand
// through its `SKILL_DIR` anchor -- once with a conforming payload and once
// with a malformed one -- and that the validator run writes nothing.
//
// The scripted model issues the exact Bash command the skill prose documents;
// the assertions read the host-visible tool parts (command, exit, output), not
// a fake parser. No marker writes are added to any production script.

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
  REPO_ROOT,
  startOpencodeServer,
  stopAllOpencodeHosts,
  TIMEOUT_MS,
} from './fixtures/receipt-workflow-host.js'

requireOpencodeAvailable(getOpencodeAvailability())
if (!isOpencodeAvailable()) {
  console.warn(
    `[systematic] skipping OpenCode-dependent tests in ce-review-return-validation.test.ts: ${opencodeAvailabilityReason()}`,
  )
}

const MOCK_PROVIDER_ID = 'systematic-ce-review-return-probe'
const MOCK_MODEL_ID = 'ce-review-return-probe-model'
const VALIDATOR_RELATIVE = 'scripts/validate-review.mjs'

// Fresh, collision-free quoted-heredoc delimiters. The old fixed token is
// deliberately embedded inside the adversarial payload to prove it cannot
// terminate the heredoc and execute the injected shell lines.
const VALID_DELIMITER = 'REVIEW_RETURN_VALID_7C1F0A'
const MALFORMED_DELIMITER = 'REVIEW_RETURN_MALFORMED_9D2E4B'
const OLD_FIXED_DELIMITER = 'SYSTEMATIC_REVIEW_RETURN_EOF'

const VALID_RETURN = JSON.stringify({
  reviewer: 'correctness',
  findings: [],
  residual_risks: [],
  testing_gaps: [],
})

function malformedReturnPayload(canaryPath: string): string {
  const canary = JSON.stringify(canaryPath)
  return [
    '{ "reviewer": "correctness", "findings": [',
    OLD_FIXED_DELIMITER,
    `touch ${canary}`,
    `$(touch ${canary})`,
  ].join('\n')
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sseChunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function responseChunks(
  response: ScriptedResponse,
  id: string,
  created: number,
): Record<string, unknown>[] {
  if (response.toolCalls && response.toolCalls.length > 0) {
    return [
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
  }
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
      const response = responses[requestIndex] ?? { text: '' }
      requestIndex += 1
      const chunks = responseChunks(
        response,
        `ce-review-return-probe-${requestIndex}`,
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
        name: 'CE Review Return Probe',
        id: MOCK_PROVIDER_ID,
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [MOCK_MODEL_ID]: {
            id: MOCK_MODEL_ID,
            name: 'CE Review Return Probe Model',
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: '2026-09-10',
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: 'unused-ce-review-return-key', baseURL: baseUrl },
      },
    },
  })
}

/** The exact command shape the skill prose documents: stdin-only, no argv JSON. */
function returnCommand(
  skillDir: string,
  payload: string,
  delimiter: string,
): string {
  return [
    `SKILL_DIR=${JSON.stringify(skillDir)};`,
    `node "$SKILL_DIR/scripts/validate-review.mjs" return <<'${delimiter}'`,
    payload,
    delimiter,
  ].join('\n')
}

function toolParts(
  messages: unknown[],
  toolName: string,
): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    if (!isRecord(message) || !Array.isArray(message.parts)) return []
    return message.parts.filter((part): part is Record<string, unknown> => {
      if (!isRecord(part)) return false
      return part.type === 'tool' && part.tool === toolName
    })
  })
}

function repoStatus(): string {
  return Bun.spawnSync(['git', 'status', '--short', '--untracked-files=all'], {
    cwd: REPO_ROOT,
  })
    .stdout.toString()
    .trim()
}

describe.skipIf(!isOpencodeAvailable())(
  'ce:review return validation — real OpenCode scripted host',
  () => {
    beforeAll(() => {
      packTarballOnce()
    }, 200_000)

    afterAll(async () => {
      await stopAllOpencodeHosts()
      cleanupPackedTarball()
    })

    test(
      'loads the packaged skill, runs the SKILL_DIR validator for conforming and malformed returns, and writes nothing',
      async () => {
        const repoStatusBefore = repoStatus()
        const fixture: IsolatedFixture = createIsolatedFixture()
        const packaged = extractPackagedPlugin(fixture)
        // Use the fixture's exposed skill path verbatim (not realpathed): the
        // validator's direct-entry guard must itself be symlink-insensitive.
        const skillDir = path.join(packaged.packageDir, 'skills/ce-review')
        const validatorPath = path.join(skillDir, VALIDATOR_RELATIVE)
        const canaryPath = path.join(fixture.tempRoot, 'heredoc-canary')

        // Precondition: the packaged skill tree actually ships the helper.
        expect(fs.existsSync(validatorPath)).toBe(true)
        const malformedPayload = malformedReturnPayload(canaryPath)
        // Each fresh delimiter must be absent as a complete line in its payload.
        expect(
          VALID_RETURN.split('\n').every((line) => line !== VALID_DELIMITER),
        ).toBe(true)
        expect(
          malformedPayload
            .split('\n')
            .every((line) => line !== MALFORMED_DELIMITER),
        ).toBe(true)

        const validCommand = returnCommand(
          skillDir,
          VALID_RETURN,
          VALID_DELIMITER,
        )
        const malformedCommand = returnCommand(
          skillDir,
          malformedPayload,
          MALFORMED_DELIMITER,
        )

        const model = startMockModelServer([
          {
            toolCalls: [
              {
                id: 'ce-review-skill-load',
                name: 'systematic_skill',
                arguments: { name: 'ce:review' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'ce-review-return-valid',
                name: 'bash',
                arguments: { command: validCommand },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 'ce-review-return-malformed',
                name: 'bash',
                arguments: { command: malformedCommand },
              },
            ],
          },
          { text: 'validation scenarios complete' },
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
          const created = await client.session.create({
            directory: fixture.projectDir,
            title: 'ce:review return validation',
            permission: [{ permission: '*', pattern: '*', action: 'allow' }],
          })
          if (created.data === undefined) {
            throw new Error('session create failed')
          }
          const sessionID = created.data.id
          await client.session.prompt({
            sessionID,
            directory: fixture.projectDir,
            model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
            parts: [
              {
                type: 'text',
                text: 'Load the ce:review skill, then run its return validator against both payloads.',
              },
            ],
          })

          const messagesResult = await client.session.messages({
            sessionID,
            directory: fixture.projectDir,
          })
          if (messagesResult.data === undefined) {
            throw new Error('session messages failed')
          }
          const messages = messagesResult.data as unknown[]

          // The ce:review skill content is loaded before any Bash validator call.
          const skillParts = toolParts(messages, 'systematic_skill')
          expect(skillParts).toHaveLength(1)
          const skillState = skillParts[0]?.state as Record<string, unknown>
          const skillOutput = skillState.output
          expect(typeof skillOutput).toBe('string')
          const skillText = skillOutput as string
          expect(skillText).toContain('<skill_content name="ce:review">')
          expect(skillText).toContain('Base directory for this skill:')
          // The prose the model sees carries the exact validator invocation.
          expect(skillText).toContain(
            'node "$SKILL_DIR/scripts/validate-review.mjs" return',
          )

          const bashParts = toolParts(messages, 'bash')
          expect(bashParts.length).toBeGreaterThanOrEqual(2)

          const describeBash = (
            part: Record<string, unknown>,
          ): {
            command: string
            exit: number
            output: string
          } => {
            const state = (part.state ?? {}) as Record<string, unknown>
            const input = isRecord(state.input) ? state.input : {}
            const metadata = isRecord(state.metadata) ? state.metadata : {}
            // `state.output` is the display string ("(no output)" when the
            // command wrote nothing to the UI stream); the captured text lives
            // in `metadata.output` on this host.
            const captured = [state.output, metadata.output].filter(
              (value): value is string =>
                typeof value === 'string' && value !== '(no output)',
            )
            return {
              command: typeof input.command === 'string' ? input.command : '',
              exit: Number(metadata.exit),
              output: captured.join('\n'),
            }
          }

          // Locate by command content rather than part id/order fragility.
          const runs = bashParts.map(describeBash)
          const validRun = runs.find((run) =>
            run.command.includes(VALID_RETURN.slice(0, 24)),
          )
          const malformedRun = runs.find((run) =>
            run.command.includes(OLD_FIXED_DELIMITER),
          )
          if (!validRun || !malformedRun) {
            throw new Error('expected both scripted validator commands to run')
          }

          // Both commands invoke the exact packaged helper through SKILL_DIR.
          for (const run of [validRun, malformedRun]) {
            expect(run.command).toContain(
              'node "$SKILL_DIR/scripts/validate-review.mjs" return',
            )
            expect(run.command).toContain(skillDir)
            // No payload in argv: the node line carries no JSON.
            const nodeLine = run.command
              .split('\n')
              .find((line) => line.includes('validate-review.mjs" return'))
            expect(nodeLine).toBeDefined()
            expect(nodeLine).not.toContain('{')
          }

          expect(validRun.exit, validRun.output).toBe(0)
          expect(validRun.output).toContain('Review return is valid')
          expect(malformedRun.exit, malformedRun.output).toBe(1)
          expect(malformedRun.output).toContain('not valid JSON')
          // The old fixed delimiter could not terminate the quoted heredoc, so
          // the injected shell lines never ran and the canary was not written.
          expect(fs.existsSync(canaryPath)).toBe(false)

          // Report-only / no-write: the validator admitted no run artifact.
          expect(
            fs.existsSync(
              path.join(fixture.projectDir, '.context/systematic/ce-review'),
            ),
          ).toBe(false)
          expect(fs.existsSync(path.join(fixture.projectDir, '.context'))).toBe(
            false,
          )
        } finally {
          await host.stop()
          model.stop()
          destroyIsolatedFixture(fixture)
        }
        expect(repoStatus()).toBe(repoStatusBefore)
      },
      TIMEOUT_MS * 3,
    )
  },
)
