import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'

import { requireOpencodeAvailable } from '../../scripts/lib/opencode-availability.js'
import {
  cleanupPackedTarball,
  createIsolatedFixture,
  destroyIsolatedFixture,
  EXACT_OPENCODE_VERSION,
  extractPackagedPlugin,
  getOpencodeAvailability,
  isOpencodeAvailable,
  packTarballOnce,
  startExactOpencodeServer,
  stopAllOpencodeHosts,
  TIMEOUT_MS,
} from './fixtures/receipt-workflow-host.js'

// See tests/integration/question-attestation-opencode.test.ts for why this
// call lives here rather than in the fixture module.
requireOpencodeAvailable(getOpencodeAvailability())

const PROVIDER = 'u7-focused-provider'
const MODEL = 'u7-focused-model'

type Mode = 'observe' | 'protected'
type ToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
}
type ModelResponse = { text?: string; toolCalls?: ToolCall[] }

/**
 * The OpenCode SDK client types every response as `{ data?: T; error?:
 * unknown }` to model transport failures. These tests always run against a
 * live host and expect success; this asserts that at the call site instead
 * of accessing `.data` with `?.`/`!` at every downstream read.
 */
function unwrapData<T>(result: { data?: T; error?: unknown }): T {
  if (result.data === undefined) {
    throw new Error(
      `opencode client call failed: ${JSON.stringify(result.error)}`,
    )
  }
  return result.data
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function startModel(responses: readonly ModelResponse[]): {
  url: string
  stop: () => void
} {
  let index = 0
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (
        request.method !== 'POST' ||
        !request.url.endsWith('/chat/completions')
      ) {
        return new Response('not found', { status: 404 })
      }
      const response = responses[index++] ?? { text: '' }
      const id = `u7-focused-${index}`
      const created = Math.floor(Date.now() / 1000)
      const chunks = response.toolCalls?.length
        ? [
            ...response.toolCalls.map((call, callIndex) => ({
              id,
              object: 'chat.completion.chunk',
              created,
              model: MODEL,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: callIndex,
                        id: call.id,
                        type: 'function',
                        function: {
                          name: call.name,
                          arguments: JSON.stringify(call.arguments),
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
              model: MODEL,
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ]
        : [
            {
              id,
              object: 'chat.completion.chunk',
              created,
              model: MODEL,
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
                    model: MODEL,
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
              model: MODEL,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            },
          ]
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(sse(chunk)))
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return Promise.resolve(
        new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      )
    },
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

function config(pluginUrl: string, modelUrl: string, _mode: Mode): string {
  return JSON.stringify({
    formatter: false,
    lsp: false,
    plugin: [pluginUrl],
    provider: {
      [PROVIDER]: {
        name: 'U7 Focused Provider',
        id: PROVIDER,
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [MODEL]: {
            id: MODEL,
            name: 'U7 Focused Model',
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
        options: { apiKey: 'unused-u7-focused-key', baseURL: modelUrl },
      },
    },
  })
}

function git(projectDir: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: projectDir })
  if (result.exitCode !== 0) {
    throw new Error(`git failed: ${args.join(' ')}`)
  }
}

function gitOutput(projectDir: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: projectDir })
  if (result.exitCode !== 0) {
    throw new Error(`git failed: ${args.join(' ')}`)
  }
  return result.stdout.toString().trim()
}

function prepareRepository(
  projectDir: string,
  file: string,
  content: string,
  remoteDir?: string,
): void {
  git(projectDir, ['init', '-q', '-b', 'main'])
  git(projectDir, ['config', 'user.email', 'u7-focused@example.invalid'])
  git(projectDir, ['config', 'user.name', 'U7 Focused'])
  fs.writeFileSync(
    path.join(projectDir, 'dogfood-check.test.ts'),
    "import { expect, test } from 'bun:test'\ntest('dogfood', () => expect(true).toBe(true))\n",
  )
  fs.writeFileSync(path.join(projectDir, file), content)
  git(projectDir, ['add', '-A'])
  git(projectDir, ['commit', '-m', 'focused dogfood baseline'])
  if (remoteDir) {
    git(projectDir, ['init', '--bare', '-q', remoteDir])
    git(projectDir, ['remote', 'add', 'origin', remoteDir])
    git(projectDir, ['push', '-q', '-u', 'origin', 'main'])
  }
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

function markerKinds(messages: unknown[]): string[] {
  return toolParts(messages).flatMap((part) => {
    const state = part.state
    if (!state || typeof state !== 'object') return []
    const metadata = (state as { metadata?: unknown }).metadata
    if (!metadata || typeof metadata !== 'object') return []
    const marker = (metadata as Record<string, unknown>)
      .systematic_workflow_receipt
    const markers = Array.isArray(marker) ? marker : marker ? [marker] : []
    return markers.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const kind = (entry as Record<string, unknown>).kind
      return typeof kind === 'string' ? [kind] : []
    })
  })
}

function resultSummary(messages: unknown[]): Array<Record<string, unknown>> {
  return toolParts(messages).map((part) => {
    const state = part.state
    if (!state || typeof state !== 'object') return { tool: part.tool }
    const value = state as Record<string, unknown>
    const metadata =
      value.metadata && typeof value.metadata === 'object'
        ? (value.metadata as Record<string, unknown>)
        : undefined
    const workflowGuard =
      metadata?.workflowGuard && typeof metadata.workflowGuard === 'object'
        ? (metadata.workflowGuard as Record<string, unknown>)
        : undefined
    return {
      callID: part.callID,
      tool: part.tool,
      status: value.status,
      state: metadata?.state,
      reasonCode: metadata?.reasonCode,
      error: value.error,
      workflowGuardStatus: workflowGuard?.status,
      workflowGuardReasonCode: workflowGuard?.reasonCode,
      exit: metadata?.exit,
    }
  })
}

function lastWorkflow(messages: unknown): Record<string, unknown> {
  const results = resultSummary(messages as unknown[])
  return (
    [...results].reverse().find((result) => result.workflowGuardStatus) ?? {}
  )
}

function callsFor(name: string, index: number): ToolCall[] {
  const file = `dogfood-${index}.txt`
  const skillName =
    name === 'git-commit'
      ? 'git-commit'
      : name === 'push'
        ? 'git-commit-push-pr'
        : 'ce:work'
  const skill: ToolCall = {
    id: `${name}-skill`,
    name: 'systematic_skill',
    arguments: { name: skillName },
  }
  const write: ToolCall = {
    id: `${name}-edit`,
    name: 'edit',
    arguments: { filePath: file, oldString: 'old', newString: `${name}-new` },
  }
  const verify: ToolCall = {
    id: `${name}-verify`,
    name: 'bash',
    arguments: { command: 'bun test dogfood-check.test.ts' },
  }
  if (name === 'git-commit') {
    return [
      skill,
      write,
      verify,
      { id: `${name}-add`, name: 'bash', arguments: { command: 'git add -A' } },
      {
        id: `${name}-commit`,
        name: 'bash',
        arguments: { command: 'git commit -m focused-commit' },
      },
      {
        id: `${name}-complete`,
        name: 'systematic_workflow_complete',
        arguments: { target: 'unit' },
      },
    ]
  }
  if (name === 'push') {
    return [
      skill,
      { ...write, id: 'push-edit' },
      verify,
      { id: 'push-add', name: 'bash', arguments: { command: 'git add -A' } },
      {
        id: 'push-commit',
        name: 'bash',
        arguments: { command: 'git commit -m focused-push' },
      },
      { id: 'push-push', name: 'bash', arguments: { command: 'git push' } },
      {
        id: 'push-status',
        name: 'systematic_workflow_status',
        arguments: {},
      },
    ]
  }
  if (name === 'no-op') {
    return [
      { ...skill, id: 'noop-skill' },
      {
        id: 'noop-write',
        name: 'write',
        arguments: { filePath: file, content: 'same' },
      },
      { id: 'noop-status', name: 'systematic_workflow_status', arguments: {} },
      {
        id: 'noop-change',
        name: 'write',
        arguments: { filePath: file, content: 'changed' },
      },
      {
        id: 'noop-final-status',
        name: 'systematic_workflow_status',
        arguments: {},
      },
    ]
  }
  return [
    skill,
    ...(name === 'protected'
      ? [
          {
            id: 'protected-early-complete',
            name: 'systematic_workflow_complete',
            arguments: { target: 'unit' },
          },
          {
            id: 'ordinary',
            name: 'bash',
            arguments: { command: 'echo ordinary' },
          },
        ]
      : []),
    write,
    verify,
    {
      id: `${name}-complete`,
      name: 'systematic_workflow_complete',
      arguments: { target: 'unit' },
    },
  ]
}

interface ScenarioResult {
  mode: Mode
  scenario: string
  workflow: Record<string, unknown>
  markerKinds: string[]
  results: Array<Record<string, unknown>>
  pid: number
  upstreamBefore?: string
  upstreamAfter?: string
  localHead?: string
}

async function runScenario(
  mode: Mode,
  name: string,
  index: number,
): Promise<ScenarioResult> {
  const fixture = createIsolatedFixture()
  const file = `dogfood-${index}.txt`
  const remoteDir =
    name === 'push' ? path.join(fixture.tempRoot, 'origin.git') : undefined
  prepareRepository(
    fixture.projectDir,
    file,
    name === 'no-op' ? 'same' : 'old',
    remoteDir,
  )
  const upstreamBefore =
    name === 'push'
      ? gitOutput(fixture.projectDir, ['rev-parse', '--verify', '@{upstream}'])
      : undefined
  if (mode === 'protected') {
    fs.mkdirSync(fixture.configDir, {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(fixture.configDir, 'systematic.json'),
      JSON.stringify({ workflow_guard: { mode: 'protected' } }),
    )
  }
  const pluginUrl = extractPackagedPlugin(fixture).pluginUrl
  const model = startModel([
    ...callsFor(name, index).map((call) => ({ toolCalls: [call] })),
    { text: `focused-${name}` },
  ])
  let host: Awaited<ReturnType<typeof startExactOpencodeServer>> | undefined
  try {
    const configText = config(pluginUrl, model.url, mode)
    host = await startExactOpencodeServer(
      fixture,
      configText,
      EXACT_OPENCODE_VERSION,
    )
    const client = createOpencodeClient({
      baseUrl: host.url,
      directory: fixture.projectDir,
    })
    const session = await client.session.create({
      directory: fixture.projectDir,
      title: `focused-${name}`,
      permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    })
    const sessionData = unwrapData(session)
    await client.session.prompt({
      sessionID: sessionData.id,
      directory: fixture.projectDir,
      model: { providerID: PROVIDER, modelID: MODEL },
      parts: [{ type: 'text', text: `Run focused ${name}.` }],
    })
    const messages = unwrapData(
      await client.session.messages({
        sessionID: sessionData.id,
        directory: fixture.projectDir,
      }),
    )
    const upstreamAfter =
      name === 'push'
        ? gitOutput(fixture.projectDir, [
            'rev-parse',
            '--verify',
            '@{upstream}',
          ])
        : undefined
    const localHead =
      name === 'push'
        ? gitOutput(fixture.projectDir, ['rev-parse', 'HEAD'])
        : undefined
    return {
      mode,
      scenario: name,
      workflow: lastWorkflow(messages),
      markerKinds: markerKinds(messages),
      results: resultSummary(messages),
      pid: host.pid,
      ...(name === 'push' ? { upstreamBefore, upstreamAfter, localHead } : {}),
    }
  } finally {
    await host?.stop()
    model.stop()
    destroyIsolatedFixture(fixture)
  }
}

describe.skipIf(!isOpencodeAvailable())('focused real-host dogfood', () => {
  beforeAll(() => {
    // No separate prewarm step: the module-scope availability probe above
    // already ran `bunx opencode-ai@<pin> --version`, which populates the
    // same uid+package-keyed bunx cache under $TMPDIR that the real hosts
    // started below reuse.
    packTarballOnce()
  }, 360_000)
  afterAll(async () => {
    await stopAllOpencodeHosts()
    cleanupPackedTarball()
  })

  test(
    'proves decisive shipping flows in isolated observe/protected hosts',
    async () => {
      const started = performance.now()
      const observe = await Promise.all(
        ['git-commit', 'ce-work', 'push', 'no-op'].map((name, index) =>
          runScenario('observe', name, index),
        ),
      )
      const protectedEvidence = await runScenario('protected', 'protected', 10)
      console.log(
        `U7_FOCUSED_DOGFOOD ${JSON.stringify({
          elapsedMs: Math.round(performance.now() - started),
          observe,
          protected: protectedEvidence,
        })}`,
      )

      const commit = observe.find((entry) => entry.scenario === 'git-commit')
      expect(commit?.workflow).toEqual(
        expect.objectContaining({
          status: 'completed',
          state: 'protected',
          reasonCode: 'unit-completed',
        }),
      )
      expect(
        commit?.markerKinds.filter((kind) => kind === 'mint').length,
      ).toBeGreaterThanOrEqual(3)

      const ceWork = observe.find((entry) => entry.scenario === 'ce-work')
      expect(ceWork?.workflow).toEqual(
        expect.objectContaining({ status: 'completed' }),
      )

      const push = observe.find((entry) => entry.scenario === 'push')
      expect(
        push?.markerKinds.filter((kind) => kind === 'mint').length,
      ).toBeGreaterThanOrEqual(4)
      expect(push?.upstreamAfter).not.toBe(push?.upstreamBefore)
      expect(push?.upstreamAfter).toBe(push?.localHead)
      // The push unit ends at push — pr-creation/check/review require real GitHub.
      // The guard status after push is 'waiting'/'missing-evidence' (pending remote ops).
      // Verify via the systematic_workflow_status result directly.
      const pushStatusResult = push?.results.find(
        (r) =>
          r.callID === 'push-status' && r.tool === 'systematic_workflow_status',
      )
      expect(pushStatusResult).toBeDefined()
      expect(pushStatusResult?.state).toBe('waiting')
      expect(pushStatusResult?.reasonCode).toBe('missing-evidence')

      const noOp = observe.find((entry) => entry.scenario === 'no-op')
      expect(noOp?.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tool: 'systematic_workflow_status',
            reasonCode: 'no-op-operation',
          }),
        ]),
      )
      expect(noOp?.markerKinds).toContain('mint')

      expect(protectedEvidence.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tool: 'bash', status: 'completed' }),
          expect.objectContaining({
            callID: 'protected-early-complete',
            status: 'error',
            error: 'workflow guard blocked',
          }),
        ]),
      )
      expect(protectedEvidence.workflow).toEqual(
        expect.objectContaining({
          status: 'completed',
          state: 'protected',
          reasonCode: 'unit-completed',
        }),
      )
      console.log(
        `U7_PROTECTED_PROOF ${JSON.stringify({
          legitimateCompletion: 'unit-completed',
          ordinaryToolCompleted: true,
        })}`,
      )
    },
    TIMEOUT_MS * 20,
  )
})
