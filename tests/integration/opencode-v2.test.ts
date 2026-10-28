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
import path from 'node:path'

import { requireOpencodeAvailable } from '../../scripts/lib/opencode-availability.js'
import { findAgentsInDir } from '../../src/lib/agents.js'
import {
  buildIsolatedOpencodeEnv,
  buildOpencodeRunArgv,
  cleanupPackedTarball,
  createIsolatedFixture,
  createOpencodeV2Client,
  destroyIsolatedFixture,
  extractPackagedPlugin,
  getOpencodeAvailability,
  type IsolatedFixture,
  isOpencodeAvailable,
  opencodeAvailabilityReason,
  packTarballOnce,
  REPO_ROOT,
  type ScriptedModelServer,
  type ScriptedResponse,
  scriptedResponseChunks,
  spawnOpencodeChild,
  startOpencodeServer,
  stopAllOpencodeHosts,
  TIMEOUT_MS,
  withScriptedProvider,
  writeHostProjectConfig,
} from './fixtures/opencode-host.js'

// This file targets the v2 host whatever `SYSTEMATIC_OPENCODE_HOST` says, so
// every harness call below names the host explicitly.
const HOST = 'v2'

requireOpencodeAvailable(getOpencodeAvailability(HOST))
if (!isOpencodeAvailable(HOST)) {
  console.warn(
    `[systematic] skipping v2 host tests in opencode-v2.test.ts: ${opencodeAvailabilityReason(HOST)}`,
  )
}

const REPLY_TEXT = 'Systematic v2 scaffold reply'

/**
 * A scripted OpenAI-compatible model that always answers with plain text: the
 * scaffold registers no tools, so no scenario here needs a tool call.
 */
function startTextModelServer(text: string): ScriptedModelServer {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        !request.url.endsWith('/chat/completions')
      ) {
        return new Response('not found', { status: 404 })
      }
      await request.text()
      const chunks = scriptedResponseChunks(
        { text },
        'v2-scaffold-response',
        Math.floor(Date.now() / 1000),
      )
      const encoder = new TextEncoder()
      const body = [
        ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
        'data: [DONE]\n\n',
      ].join('')
      return new Response(encoder.encode(body), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

const SCRIPTED_PROVIDER = 'systematic-host-contract-provider'
const SCRIPTED_MODEL = 'systematic-host-contract-model'

interface ToolScriptedModel extends ScriptedModelServer {
  /** The text of every tool result the model was shown, in order. */
  toolResults: string[]
}

function messageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n')
}

/**
 * A scripted model that turns a `@@TOOL <name> <json>` line in the latest user
 * message into one tool call, and answers plain text once it has seen the
 * result. Title requests (no tools offered) get a fixed title.
 */
function startToolModelServer(): ToolScriptedModel {
  const toolResults: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        !request.url.endsWith('/chat/completions')
      ) {
        return new Response('not found', { status: 404 })
      }
      const body = (await request.json()) as {
        tools?: unknown[]
        messages?: unknown[]
      }
      const messages = body.messages ?? []
      const last = messages.at(-1) as { role?: string } | undefined
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0
      const lastUser = messageText(
        [...messages]
          .reverse()
          .find((m) => (m as { role?: string }).role === 'user'),
      )
      const call = /@@TOOL (\S+) (.*)$/m.exec(lastUser)

      let response: ScriptedResponse = { text: 'Scripted title' }
      if (hasTools && last?.role === 'tool') {
        toolResults.push(messageText(last))
        response = { text: 'Tool call finished.' }
      } else if (hasTools && call?.[1] !== undefined && call[2] !== undefined) {
        response = {
          toolCalls: [
            {
              id: `call-${toolResults.length + 1}`,
              name: call[1],
              arguments: JSON.parse(call[2]) as Record<string, unknown>,
            },
          ],
        }
      } else if (hasTools) {
        response = { text: 'No tool requested.' }
      }

      const chunks = scriptedResponseChunks(
        response,
        'v2-agents-response',
        Math.floor(Date.now() / 1000),
      )
      const payload = [
        ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
        'data: [DONE]\n\n',
      ].join('')
      return new Response(payload, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
    toolResults,
  }
}

describe.skipIf(!isOpencodeAvailable(HOST) || process.platform === 'win32')(
  'OpenCode v2 adapter scaffold on the pinned host',
  () => {
    let fixture: IsolatedFixture
    let model: ScriptedModelServer

    beforeAll(() => {
      packTarballOnce()
    }, 200_000)

    afterAll(async () => {
      await stopAllOpencodeHosts()
      cleanupPackedTarball()
    })

    beforeEach(() => {
      fixture = createIsolatedFixture()
      model = startTextModelServer(REPLY_TEXT)
    })

    afterEach(() => {
      model.stop()
      destroyIsolatedFixture(fixture)
    })

    function writeProjectSystematicConfig(content: string): void {
      fs.mkdirSync(path.join(fixture.projectDir, '.opencode'), {
        recursive: true,
      })
      fs.writeFileSync(
        path.join(fixture.projectDir, '.opencode/systematic.json'),
        content,
      )
    }

    async function runPrompt(pluginSpec: string) {
      const configContent = withScriptedProvider(
        JSON.stringify({ plugins: [pluginSpec] }),
        model.url,
        HOST,
      )
      writeHostProjectConfig(fixture, configContent, HOST)
      return spawnOpencodeChild(
        buildOpencodeRunArgv(HOST, 'Reply with a short greeting.'),
        {
          cwd: fixture.projectDir,
          env: buildIsolatedOpencodeEnv(
            fixture,
            configContent,
            undefined,
            HOST,
          ),
          timeoutMs: TIMEOUT_MS,
        },
      )
    }

    test(
      'the packed plugin loads, setup runs once and stderr carries nothing unexpected',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        // A removed bundled name makes the config loader emit exactly one
        // warning per load, which is the observable proof that `setup` loaded
        // the config once.
        writeProjectSystematicConfig(
          JSON.stringify({ disabled_skills: ['orchestrating-swarms'] }),
        )

        const result = await runPrompt(pluginSpec)

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain(REPLY_TEXT)

        const removedNameWarnings = result.stderr
          .split('\n')
          .filter((line) => line.includes('orchestrating-swarms'))
        expect(removedNameWarnings).toHaveLength(1)
        expect(removedNameWarnings[0]).toContain(
          '[systematic] "orchestrating-swarms" in `disabled_skills` is no longer a bundled name and will be ignored.',
        )

        const unexpected = result.stderr
          .split('\n')
          .filter((line) => !line.includes('orchestrating-swarms'))
          .filter((line) =>
            /failed to load plugin|disabled plugin|systematic:|Invalid Systematic config/i.test(
              line,
            ),
          )
        expect(unexpected).toEqual([])
      },
      TIMEOUT_MS,
    )

    test(
      'invalid systematic.json fails the plugin load, is logged, and the session still answers',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        writeProjectSystematicConfig('{ "bootstrap": ')

        const result = await runPrompt(pluginSpec)

        // The host logs the failed load and stays usable without the plugin.
        expect(result.stderr).toContain('failed to load plugin')
        expect(result.stderr).toContain('Invalid Systematic config in')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain(REPLY_TEXT)
      },
      TIMEOUT_MS,
    )

    async function startAgentHost(
      pluginSpec: string,
      toolModel: ToolScriptedModel,
      extraConfig: Record<string, unknown> = {},
    ) {
      const configContent = withScriptedProvider(
        JSON.stringify({ plugins: [pluginSpec], ...extraConfig }),
        toolModel.url,
        HOST,
      )
      const server = await startOpencodeServer(
        fixture,
        configContent,
        undefined,
        HOST,
      )
      const client = await createOpencodeV2Client(server)
      return { server, client }
    }

    async function listAgents(
      client: Awaited<ReturnType<typeof startAgentHost>>['client'],
    ) {
      const listed = await client.agent.list({
        location: { directory: fixture.projectDir },
      })
      return listed.data
    }

    test(
      'the bundled agents appear in the agent list with their v1 description and prompt',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        const toolModel = startToolModelServer()
        const { server, client } = await startAgentHost(pluginSpec, toolModel)
        try {
          const listed = await listAgents(client)

          const byId = new Map(listed.map((agent) => [String(agent.id), agent]))
          const bundled = findAgentsInDir(path.join(REPO_ROOT, 'agents'))
          expect(bundled.length).toBeGreaterThan(10)
          for (const { name } of bundled) {
            const agent = byId.get(name)
            expect(agent, `agent ${name} is listed`).toBeDefined()
            expect(agent?.mode).toBe('subagent')
            expect(agent?.description).toEndWith('- Systematic)')
            expect(agent?.system?.length ?? 0).toBeGreaterThan(50)
          }
        } finally {
          toolModel.stop()
          await server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'a user agent with the same id in config keeps the user system prompt',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        const toolModel = startToolModelServer()
        const { server, client } = await startAgentHost(pluginSpec, toolModel, {
          agents: { 'repo-research-analyst': { system: 'USER-SYSTEM-MARKER' } },
        })
        try {
          const listed = await listAgents(client)

          const agent = listed.find(
            (a) => String(a.id) === 'repo-research-analyst',
          )
          // The user's config applies after the plugin's transform: the user's
          // prompt wins and the plugin's other fields stay.
          expect(agent?.system).toBe('USER-SYSTEM-MARKER')
          expect(agent?.description).toEndWith('- Systematic)')
          expect(
            listed.filter((a) => String(a.id) === 'repo-research-analyst'),
          ).toHaveLength(1)
        } finally {
          toolModel.stop()
          await server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'an agent with a managed skills list is refused a skill outside it, and an unmanaged agent is not',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        // Two on-disk skills: one the managed list allows, one it does not.
        for (const id of ['git-worktree', 'denied-probe']) {
          const dir = path.join(fixture.projectDir, '.opencode/skills', id)
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(
            path.join(dir, 'SKILL.md'),
            `---\nname: ${id}\ndescription: Probe skill ${id}\n---\n# ${id}\n\nBODY-OF-${id}\n`,
          )
        }
        // Overlays that restrict tools are read from user-level config.
        fs.writeFileSync(
          path.join(fixture.configDir, 'systematic.json'),
          JSON.stringify({
            agents: {
              'repo-research-analyst': {
                mode: 'primary',
                skills: ['git-worktree'],
              },
              'correctness-reviewer': { mode: 'primary' },
            },
          }),
        )
        const toolModel = startToolModelServer()
        const { server, client } = await startAgentHost(pluginSpec, toolModel)
        try {
          const run = async (agent: string, skillId: string) => {
            const before = toolModel.toolResults.length
            const session = await client.session.create({
              location: { directory: fixture.projectDir },
              agent,
              model: { providerID: SCRIPTED_PROVIDER, id: SCRIPTED_MODEL },
            })
            await client.session.prompt({
              sessionID: session.id,
              text: `@@TOOL skill ${JSON.stringify({ id: skillId })}`,
            })
            await client.session.wait({ sessionID: session.id })
            return toolModel.toolResults.slice(before).join('\n')
          }

          const deniedForManaged = await run(
            'repo-research-analyst',
            'denied-probe',
          )
          expect(deniedForManaged).toContain('permission.rejected')
          expect(deniedForManaged).not.toContain('BODY-OF-denied-probe')

          const allowedForManaged = await run(
            'repo-research-analyst',
            'git-worktree',
          )
          expect(allowedForManaged).toContain('BODY-OF-git-worktree')

          const loadedByUnmanaged = await run(
            'correctness-reviewer',
            'denied-probe',
          )
          expect(loadedByUnmanaged).toContain('BODY-OF-denied-probe')
        } finally {
          toolModel.stop()
          await server.stop()
        }
      },
      TIMEOUT_MS,
    )
  },
)
