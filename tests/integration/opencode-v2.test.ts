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
import { createConfigHandler } from '../../src/lib/config-handler.js'
import { createSkillToolDescriptor } from '../../src/lib/skill-tool.js'
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
  /** Every tool name the model was offered, across all requests. */
  toolNames: Set<string>
  /** The text of every tool result in the latest request that offered tools, history included. */
  latestToolHistory: string[]
  /** Every request that offered tools, which is every model turn but not the title request. */
  turns: ChatRequestBody[]
  /** Every request, in arrival order, including the title request that offers no tools. */
  requests: ChatRequestBody[]
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

interface ChatRequestBody {
  model?: string
  tools?: unknown[]
  messages?: unknown[]
}

function roleOf(message: unknown): string | undefined {
  return (message as { role?: string } | undefined)?.role
}

/** Notes which tools a request offered and which tool results its history carries. */
function recordRequest(model: ToolScriptedModel, body: ChatRequestBody): void {
  for (const tool of body.tools ?? []) {
    const name = (tool as { function?: { name?: unknown } }).function?.name
    if (typeof name === 'string') model.toolNames.add(name)
  }
  model.latestToolHistory.length = 0
  for (const message of body.messages ?? []) {
    if (roleOf(message) === 'tool') {
      model.latestToolHistory.push(messageText(message))
    }
  }
}

function scriptResponse(
  model: ToolScriptedModel,
  body: ChatRequestBody,
): ScriptedResponse {
  const messages = body.messages ?? []
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0
  // A request that offers no tools is the title request.
  if (!hasTools) return { text: 'Scripted title' }
  const last = messages.at(-1)
  if (roleOf(last) === 'tool') {
    model.toolResults.push(messageText(last))
    return { text: 'Tool call finished.' }
  }
  const lastUser = messageText(
    [...messages].reverse().find((m) => roleOf(m) === 'user'),
  )
  const call = /@@TOOL (\S+) (.*)$/m.exec(lastUser)
  if (call?.[1] === undefined || call[2] === undefined) {
    return { text: `Scripted reply to: ${lastUser.slice(0, 120)}` }
  }
  return {
    toolCalls: [
      {
        id: `call-${model.toolResults.length + 1}`,
        name: call[1],
        arguments: JSON.parse(call[2]) as Record<string, unknown>,
      },
    ],
  }
}

/**
 * A scripted model that turns a `@@TOOL <name> <json>` line in the latest user
 * message into one tool call, and answers plain text once it has seen the
 * result. Title requests (no tools offered) get a fixed title.
 */
function startToolModelServer(): ToolScriptedModel {
  const state = {
    toolResults: [] as string[],
    toolNames: new Set<string>(),
    latestToolHistory: [] as string[],
    turns: [] as ChatRequestBody[],
    requests: [] as ChatRequestBody[],
  }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        !request.url.endsWith('/chat/completions')
      ) {
        return new Response('not found', { status: 404 })
      }
      const body = (await request.json()) as ChatRequestBody
      model.requests.push(body)
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        recordRequest(model, body)
        model.turns.push(body)
      }
      const chunks = scriptedResponseChunks(
        scriptResponse(model, body),
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
  const model: ToolScriptedModel = {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
    ...state,
  }
  return model
}

/** Adds a second model to the scripted provider, so a command can switch to it. */
function withAltModel(configContent: string): string {
  const parsed = JSON.parse(configContent) as {
    providers: Record<string, { models: Record<string, unknown> }>
  }
  const provider = parsed.providers[SCRIPTED_PROVIDER]
  if (provider === undefined) throw new Error('scripted provider missing')
  provider.models[ALT_MODEL] = { name: 'Alternate Model' }
  return JSON.stringify(parsed)
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** The text of the last user message in a recorded model request. */
function lastUserText(body: ChatRequestBody): string {
  const user = [...(body.messages ?? [])]
    .reverse()
    .find((message) => roleOf(message) === 'user')
  return messageText(user)
}

function systemText(body: ChatRequestBody): string {
  return (body.messages ?? [])
    .filter((message) => roleOf(message) === 'system')
    .map((message) => messageText(message))
    .join('\n')
}

const ALT_MODEL = 'alternate-model'
const AGENT_PROMPT_MARKER = 'You are an expert repository research analyst'

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
      options: { altModel?: boolean } = {},
    ) {
      const scripted = withScriptedProvider(
        JSON.stringify({ plugins: [pluginSpec], ...extraConfig }),
        toolModel.url,
        HOST,
      )
      const configContent = options.altModel ? withAltModel(scripted) : scripted
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

    type AgentHost = Awaited<ReturnType<typeof startAgentHost>>

    /** Runs one scripted tool call in a fresh session and returns the tool result the model saw. */
    async function callTool(
      host: AgentHost,
      toolModel: ToolScriptedModel,
      call: { tool: string; args: Record<string, unknown>; agent?: string },
    ): Promise<string> {
      const before = toolModel.toolResults.length
      const session = await host.client.session.create({
        location: { directory: fixture.projectDir },
        ...(call.agent === undefined ? {} : { agent: call.agent }),
        model: { providerID: SCRIPTED_PROVIDER, id: SCRIPTED_MODEL },
      })
      await host.client.session.prompt({
        sessionID: session.id,
        text: `@@TOOL ${call.tool} ${JSON.stringify(call.args)}`,
      })
      await host.client.session.wait({ sessionID: session.id })
      return toolModel.toolResults.slice(before).join('\n')
    }

    test(
      'systematic_skill is offered to the model and loads an enabled skill by bare and prefixed name',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const bare = await callTool(host, toolModel, {
            tool: 'systematic_skill',
            args: { name: 'git-clean-gone-branches' },
          })
          const prefixed = await callTool(host, toolModel, {
            tool: 'systematic_skill',
            args: { name: 'systematic:git-clean-gone-branches' },
          })

          expect([...toolModel.toolNames]).toContain('systematic_skill')
          expect(bare).toContain(
            '<skill_content name="systematic:git-clean-gone-branches">',
          )
          expect(bare).toContain('Base directory for this skill:')
          expect(prefixed).toBe(bare)
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'the native skill tool sees the registered bundled skills, and not a disabled one',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        writeProjectSystematicConfig(
          JSON.stringify({ disabled_skills: ['git-worktree'] }),
        )
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const plain = await callTool(host, toolModel, {
            tool: 'skill',
            args: { id: 'git-clean-gone-branches' },
          })
          // A skill whose name carries a colon keeps it as its id.
          const colon = await callTool(host, toolModel, {
            tool: 'skill',
            args: { id: 'ce:brainstorm' },
          })
          const disabled = await callTool(host, toolModel, {
            tool: 'skill',
            args: { id: 'git-worktree' },
          })

          expect(plain).toContain(
            '<skill_content name="git-clean-gone-branches">',
          )
          expect(plain).toContain('Base directory for this skill:')
          expect(colon).toContain('<skill_content name="ce:brainstorm">')
          expect(disabled).not.toContain('<skill_content')
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'a skill in disabled_skills is refused by systematic_skill',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        writeProjectSystematicConfig(
          JSON.stringify({ disabled_skills: ['git-worktree'] }),
        )
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const refused = await callTool(host, toolModel, {
            tool: 'systematic_skill',
            args: { name: 'systematic:git-worktree' },
          })
          const control = await callTool(host, toolModel, {
            tool: 'systematic_skill',
            args: { name: 'git-clean-gone-branches' },
          })

          expect(refused).toContain('not found')
          expect(refused).not.toContain('<skill_content')
          expect(control).toContain('<skill_content')
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'systematic_skill refuses a skill a managed agent may not load while a sibling agent loads it',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
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
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const denied = await callTool(host, toolModel, {
            tool: 'systematic_skill',
            args: { name: 'systematic:git-clean-gone-branches' },
            agent: 'repo-research-analyst',
          })
          const allowed = await callTool(host, toolModel, {
            tool: 'systematic_skill',
            args: { name: 'systematic:git-worktree' },
            agent: 'repo-research-analyst',
          })
          const sibling = await callTool(host, toolModel, {
            tool: 'systematic_skill',
            args: { name: 'systematic:git-clean-gone-branches' },
            agent: 'correctness-reviewer',
          })

          expect(denied).not.toContain('<skill_content')
          expect(denied.toLowerCase()).toContain('permission')
          expect(allowed).toContain(
            '<skill_content name="systematic:git-worktree">',
          )
          expect(sibling).toContain(
            '<skill_content name="systematic:git-clean-gone-branches">',
          )
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'arguments are substituted into the skill the model receives',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const result = await callTool(host, toolModel, {
            tool: 'systematic_skill',
            args: { name: 'reproduce-bug', arguments: 'ISSUE-ARG-MARKER-4471' },
          })

          expect(result).toContain('ISSUE-ARG-MARKER-4471')
          expect(result).not.toContain('$ARGUMENTS')
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'an on-disk skill with the same id replaces the registered one in the native tool, with no diagnostic',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        const dir = path.join(
          fixture.projectDir,
          '.opencode/skills/git-worktree',
        )
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
          path.join(dir, 'SKILL.md'),
          '---\nname: git-worktree\ndescription: User copy\n---\n# User copy\n\nUSER-SKILL-BODY\n',
        )
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const native = await callTool(host, toolModel, {
            tool: 'skill',
            args: { id: 'git-worktree' },
          })

          // The host drops the bundled copy without telling the plugin, so the
          // replacement is silent. The user's copy is what the native tool loads.
          expect(native).toContain('USER-SKILL-BODY')
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'a skill above the host output limit reaches the model in full on the continuation request and later turns',
      async () => {
        const { pluginSpec, packageDir } = extractPackagedPlugin(fixture, HOST)
        const expected = createSkillToolDescriptor({
          // The packed copy by its real path, which is what the host loads, so the
          // base directory in the text matches.
          bundledSkillsDir: path.join(fs.realpathSync(packageDir), 'skills'),
          disabledSkills: [],
        }).load({ name: 'ce:review' }).output
        // The premise: this skill is over the host's 51200 byte limit.
        expect(Buffer.byteLength(expected)).toBeGreaterThan(51_200)

        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const session = await host.client.session.create({
            location: { directory: fixture.projectDir },
            model: { providerID: SCRIPTED_PROVIDER, id: SCRIPTED_MODEL },
          })
          await host.client.session.prompt({
            sessionID: session.id,
            text: '@@TOOL systematic_skill {"name":"ce:review"}',
          })
          await host.client.session.wait({ sessionID: session.id })

          // The continuation request carried the whole skill, no cut marker.
          expect(toolModel.toolResults).toHaveLength(1)
          expect(toolModel.toolResults[0]).toBe(expected)
          expect(toolModel.toolResults[0]).not.toContain('[showing lines')

          // A later turn rebuilds the request from history: still whole.
          await host.client.session.prompt({
            sessionID: session.id,
            text: 'Carry on.',
          })
          await host.client.session.wait({ sessionID: session.id })
          expect(toolModel.latestToolHistory).toEqual([expected])
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    /**
     * A skill file under `root`. A discovered project skill becomes a command
     * under its bare name, with a template and a description only. A skill in
     * the bundled directory becomes `systematic:<name>` and can also name an
     * `agent`, a `model` and `subtask`, so the routing tests add theirs to the
     * extracted copy of the package.
     */
    function writeSkill(
      root: string,
      name: string,
      frontmatter: Record<string, string>,
      body: string,
    ): void {
      const dir = path.join(root, name)
      fs.mkdirSync(dir, { recursive: true })
      const lines = Object.entries({
        name,
        description: `Probe command ${name}`,
        ...frontmatter,
      }).map(([key, value]) => `${key}: ${value}`)
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\n${lines.join('\n')}\n---\n${body}\n`,
      )
    }

    function writeCommandSkill(
      name: string,
      frontmatter: Record<string, string>,
      body: string,
    ): void {
      writeSkill(
        path.join(fixture.projectDir, '.claude/skills'),
        name,
        frontmatter,
        body,
      )
    }

    function writeBundledSkill(
      packageDir: string,
      name: string,
      frontmatter: Record<string, string>,
      body: string,
    ): void {
      writeSkill(path.join(packageDir, 'skills'), name, frontmatter, body)
    }

    /** The command list, once `ready` accepts it: plugin commands arrive after the built-ins. */
    async function listCommands(
      host: AgentHost,
      ready: (entries: { name: string }[]) => boolean,
    ) {
      let names: { name: string; description: string | undefined }[] = []
      await waitFor(async () => {
        const listed = await host.client.command.list({
          location: { directory: fixture.projectDir },
        })
        names = listed.data.map((entry) => ({
          name: String(entry.name),
          description: entry.description,
        }))
        return ready(names)
      }, 'the command list')
      return names
    }

    /** Lets the bundled agent run as a primary agent, which its own mode does not. */
    function allowAgentAsPrimary(agent: string): void {
      fs.writeFileSync(
        path.join(fixture.configDir, 'systematic.json'),
        JSON.stringify({ agents: { [agent]: { mode: 'primary' } } }),
      )
    }

    async function newSession(host: AgentHost, agent = 'build') {
      return host.client.session.create({
        location: { directory: fixture.projectDir },
        agent,
        model: { providerID: SCRIPTED_PROVIDER, id: SCRIPTED_MODEL },
      })
    }

    async function sessionState(host: AgentHost, sessionID: string) {
      return host.client.session.get({ sessionID })
    }

    test(
      'a command with $ARGUMENTS reaches the model expanded, on its configured agent, and the session goes back afterwards',
      async () => {
        const { pluginSpec, packageDir } = extractPackagedPlugin(fixture, HOST)
        allowAgentAsPrimary('repo-research-analyst')
        writeBundledSkill(
          packageDir,
          'probe-args',
          { agent: 'repo-research-analyst' },
          'Investigate carefully: $ARGUMENTS',
        )
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const session = await newSession(host)
          await host.client.session.command({
            sessionID: session.id,
            name: 'systematic:probe-args',
            text: 'ARG-MARKER-9',
          })
          await waitFor(() => toolModel.turns.length > 0, 'the command turn')

          const turn = toolModel.turns[0]
          if (turn === undefined) throw new Error('no turn recorded')
          const prompt = lastUserText(turn)
          expect(prompt).toContain('Investigate carefully: ARG-MARKER-9')
          expect(prompt).toContain(
            '<user-request>\nARG-MARKER-9\n</user-request>',
          )
          expect(prompt).not.toContain('$ARGUMENTS')
          // The turn ran on the command's agent: its prompt is the system prompt.
          expect(systemText(turn)).toContain(AGENT_PROMPT_MARKER)

          // The session is put back on its own agent once the turn is done.
          await waitFor(
            async () =>
              (await sessionState(host, session.id)).agent === 'build',
            'the session to return to its agent',
          )
          await host.client.session.prompt({
            sessionID: session.id,
            text: 'A plain follow-up.',
          })
          await host.client.session.wait({ sessionID: session.id })
          const followUp = toolModel.turns.at(-1)
          if (followUp === undefined) throw new Error('no follow-up turn')
          expect(systemText(followUp)).not.toContain(AGENT_PROMPT_MARKER)
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'a command with a model runs the turn on that model and the session returns to its own',
      async () => {
        const { pluginSpec, packageDir } = extractPackagedPlugin(fixture, HOST)
        writeBundledSkill(
          packageDir,
          'probe-model',
          { model: `${SCRIPTED_PROVIDER}/${ALT_MODEL}` },
          'Use the other model for: $ARGUMENTS',
        )
        const toolModel = startToolModelServer()
        const host = await startAgentHost(
          pluginSpec,
          toolModel,
          {},
          {
            altModel: true,
          },
        )
        try {
          const session = await newSession(host)
          await host.client.session.command({
            sessionID: session.id,
            name: 'systematic:probe-model',
            text: 'MODEL-ARG',
          })
          await waitFor(() => toolModel.turns.length > 0, 'the command turn')

          expect(toolModel.turns[0]?.model).toBe(ALT_MODEL)
          await waitFor(
            async () =>
              (await sessionState(host, session.id)).model?.id ===
              SCRIPTED_MODEL,
            'the session to return to its model',
          )
          await host.client.session.prompt({
            sessionID: session.id,
            text: 'A plain follow-up.',
          })
          await host.client.session.wait({ sessionID: session.id })
          expect(toolModel.turns.at(-1)?.model).toBe(SCRIPTED_MODEL)
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'a subagent-mode command runs in a child session and its result comes back to the parent',
      async () => {
        const { pluginSpec, packageDir } = extractPackagedPlugin(fixture, HOST)
        writeBundledSkill(
          packageDir,
          'probe-sub',
          { agent: 'repo-research-analyst' },
          'Audit for the parent: $ARGUMENTS',
        )
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const session = await newSession(host)
          await host.client.session.command({
            sessionID: session.id,
            name: 'systematic:probe-sub',
            text: 'SUB-ARG-5',
          })
          await waitFor(
            () =>
              toolModel.turns.some((turn) =>
                lastUserText(turn).includes(
                  'Result of command systematic:probe-sub',
                ),
              ),
            'the result to reach the parent',
          )

          // The child ran the expanded prompt on the command's agent.
          const childTurn = toolModel.turns.find(
            (turn) =>
              lastUserText(turn).includes('Audit for the parent: SUB-ARG-5') &&
              !lastUserText(turn).includes('Result of command'),
          )
          expect(childTurn).toBeDefined()
          expect(systemText(childTurn as ChatRequestBody)).toContain(
            AGENT_PROMPT_MARKER,
          )

          // The parent saw the child's reply, and kept its own agent.
          const parentTurn = toolModel.turns.find((turn) =>
            lastUserText(turn).includes(
              'Result of command systematic:probe-sub',
            ),
          ) as ChatRequestBody
          expect(lastUserText(parentTurn)).toContain('Scripted reply to:')
          expect(lastUserText(parentTurn)).toContain('(subagent session ses_')
          expect(systemText(parentTurn)).not.toContain(AGENT_PROMPT_MARKER)
          expect((await sessionState(host, session.id)).agent).toBe('build')

          // The child is a session of its own, attached to the parent.
          const listed = await host.client.session.list({
            parentID: session.id,
          })
          const children = listed.data
          expect(children).toHaveLength(1)
          expect(children[0]?.agent).toBe('repo-research-analyst')
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'a !-backtick block in a command stays literal text in the prompt',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        const marker = path.join(fixture.tmpDir, 'bang-ran.txt')
        writeCommandSkill(
          'probe-bang',
          {},
          `Before !\`echo BANG-LITERAL-77 > ${marker}\` after $ARGUMENTS`,
        )
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const session = await newSession(host)
          await host.client.session.command({
            sessionID: session.id,
            name: 'probe-bang',
            text: 'x',
          })
          await waitFor(() => toolModel.turns.length > 0, 'the command turn')

          const turn = toolModel.turns[0] as ChatRequestBody
          expect(lastUserText(turn)).toContain(
            `!\`echo BANG-LITERAL-77 > ${marker}\``,
          )
          // Nothing ran the block.
          expect(fs.existsSync(marker)).toBe(false)
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'a command whose agent is not registered runs on the current agent, with one diagnostic',
      async () => {
        const { pluginSpec, packageDir } = extractPackagedPlugin(fixture, HOST)
        writeBundledSkill(
          packageDir,
          'probe-ghost',
          { agent: 'ghost-agent' },
          'Run anyway: $ARGUMENTS',
        )
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const session = await newSession(host)
          for (const text of ['ONE', 'TWO']) {
            const before = toolModel.turns.length
            await host.client.session.command({
              sessionID: session.id,
              name: 'systematic:probe-ghost',
              text,
            })
            await waitFor(
              () => toolModel.turns.length > before,
              `the turn for ${text}`,
            )
            await host.client.session.wait({ sessionID: session.id })
            expect(
              lastUserText(toolModel.turns.at(-1) as ChatRequestBody),
            ).toContain(`Run anyway: ${text}`)
          }

          // The turns worked, on the session's own agent.
          expect((await sessionState(host, session.id)).agent).toBe('build')
          const notes = host.server
            .output()
            .split('\n')
            .filter((line) => line.includes('names agent "ghost-agent"'))
          expect(notes).toHaveLength(1)
          expect(notes[0]).toContain('systematic: ')
          expect(notes[0]).toContain('"systematic:probe-ghost"')
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'the command names and descriptions match the v1 set',
      async () => {
        const { pluginSpec, packageDir } = extractPackagedPlugin(fixture, HOST)
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const v2 = new Map(
            (
              await listCommands(host, (entries) =>
                entries.some((entry) => entry.name.startsWith('systematic:')),
              )
            )
              .filter((entry) => entry.name.startsWith('systematic:'))
              .map((entry) => [entry.name, entry.description]),
          )

          const root = fs.realpathSync(packageDir)
          const v1Config: {
            command?: Record<string, { description?: string }>
          } = {}
          await createConfigHandler({
            directory: fixture.projectDir,
            bundledSkillsDir: path.join(root, 'skills'),
            bundledAgentsDir: path.join(root, 'agents'),
            bundledCommandsDir: path.join(root, 'commands'),
            homeDir: fixture.homeDir,
          })(v1Config as never)
          const v1 = new Map(
            Object.entries(v1Config.command ?? {})
              .filter(([name]) => name.startsWith('systematic:'))
              .map(([name, command]) => [name, command.description]),
          )

          expect(v2.size).toBeGreaterThan(10)
          expect([...v2.keys()].sort()).toEqual([...v1.keys()].sort())
          for (const [name, description] of v2) {
            expect(description).toBe(v1.get(name))
            expect(description?.startsWith('(Systematic) ')).toBe(true)
          }
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'a discovered skill named like a built-in command is skipped and the built-in stays',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        writeCommandSkill(
          'review',
          {},
          'A skill that would replace the built-in.',
        )
        writeCommandSkill('probe-neighbour', {}, 'Registers beside it.')
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const byName = new Map(
            (
              await listCommands(host, (entries) =>
                entries.some((entry) => entry.name === 'probe-neighbour'),
              )
            ).map((entry) => [entry.name, entry.description]),
          )

          expect(byName.has('probe-neighbour')).toBe(true)
          // The built-in's own description, not the skill's.
          expect(byName.get('review')).not.toContain('Probe command review')
          expect(byName.get('review')).toContain('review changes')
          const notes = host.server
            .output()
            .split('\n')
            .filter((line) => line.includes('name of a built-in command'))
          expect(notes).toHaveLength(1)
          expect(notes[0]).toContain('"review"')
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    const BOOTSTRAP_KEY = 'systematic.bootstrap'
    const BOOTSTRAP_ENTRY = `<context key="${BOOTSTRAP_KEY}">`
    const WORKTREE_RULE_LINE =
      'create it at `.worktrees/<branch>` under the main repository root'

    function occurrences(text: string, needle: string): number {
      return text.split(needle).length - 1
    }

    /** One prompt in a fresh session, run to the end. Returns the session id. */
    async function promptNewSession(
      host: AgentHost,
      text: string,
    ): Promise<string> {
      const session = await newSession(host)
      await host.client.session.prompt({ sessionID: session.id, text })
      await host.client.session.wait({ sessionID: session.id })
      return session.id
    }

    async function entryKeys(host: AgentHost, sessionID: string) {
      const entries = await host.client.session.instructions.entry.list({
        sessionID,
      })
      return entries.map((entry) => entry.key)
    }

    test(
      'the first request of a new session carries the bootstrap with the v2 profile, once',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const sessionID = await promptNewSession(host, 'Say hello.')

          const first = toolModel.turns[0]
          if (first === undefined) throw new Error('no turn recorded')
          const system = systemText(first)
          expect(occurrences(system, BOOTSTRAP_ENTRY)).toBe(1)
          expect(occurrences(system, '<SYSTEMATIC_WORKFLOWS>')).toBe(1)
          expect(system).toContain('# OpenCode v2 Capability Profile')
          expect(system).toContain('subagent({')
          expect(system).toContain('systematic_skill({ name:')
          // The v1 profile's mechanisms are not what this host offers.
          expect(system).not.toContain('# OpenCode Capability Profile')
          expect(system).not.toContain('subagent_type')
          // The worktree rule is there by default.
          expect(system).toContain(WORKTREE_RULE_LINE)
          expect(await entryKeys(host, sessionID)).toEqual([BOOTSTRAP_KEY])
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'the title request does not carry the bootstrap',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          await promptNewSession(host, 'Say hello.')
          // The title is generated beside the first turn; it offers no tools.
          await waitFor(
            () =>
              toolModel.requests.some(
                (request) => (request.tools ?? []).length === 0,
              ),
            'the title request',
          )

          const titles = toolModel.requests.filter(
            (request) => (request.tools ?? []).length === 0,
          )
          expect(titles.length).toBeGreaterThan(0)
          for (const title of titles) {
            expect(systemText(title)).not.toContain(BOOTSTRAP_ENTRY)
            expect(systemText(title)).not.toContain('<SYSTEMATIC_WORKFLOWS>')
          }
          // The turn that did run had it, so the absence above is not a bad probe.
          expect(systemText(toolModel.turns[0] as ChatRequestBody)).toContain(
            BOOTSTRAP_ENTRY,
          )
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'a subagent request carries the bootstrap once, and so does the parent request that follows it',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const call = JSON.stringify({
            agent: 'general',
            description: 'Child task',
            prompt: 'CHILD-BOOT-MARK',
          })
          const parentID = await promptNewSession(
            host,
            `@@TOOL subagent ${call}`,
          )

          const childTurns = toolModel.turns.filter((turn) => {
            const user = lastUserText(turn)
            return user.includes('CHILD-BOOT-MARK') && !user.includes('@@TOOL')
          })
          expect(childTurns).toHaveLength(1)
          expect(
            occurrences(
              systemText(childTurns[0] as ChatRequestBody),
              BOOTSTRAP_ENTRY,
            ),
          ).toBe(1)

          // The parent's continuation, after the tool result, is not doubled.
          const continuation = toolModel.turns.find(
            (turn) => roleOf(turn.messages?.at(-1)) === 'tool',
          )
          expect(continuation).toBeDefined()
          expect(
            occurrences(
              systemText(continuation as ChatRequestBody),
              BOOTSTRAP_ENTRY,
            ),
          ).toBe(1)

          // The child has an entry of its own.
          const children = await host.client.session.list({ parentID })
          expect(children.data).toHaveLength(1)
          expect(await entryKeys(host, children.data[0]?.id as string)).toEqual(
            [BOOTSTRAP_KEY],
          )
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'git-worktree in disabled_skills leaves the worktree rule out of the bootstrap',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        writeProjectSystematicConfig(
          JSON.stringify({ disabled_skills: ['git-worktree'] }),
        )
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          await promptNewSession(host, 'Say hello.')

          const system = systemText(toolModel.turns[0] as ChatRequestBody)
          expect(occurrences(system, BOOTSTRAP_ENTRY)).toBe(1)
          expect(system).toContain('# OpenCode v2 Capability Profile')
          expect(system).not.toContain(WORKTREE_RULE_LINE)
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'bootstrap.enabled false puts no entry and nothing reaches the model',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        writeProjectSystematicConfig(
          JSON.stringify({ bootstrap: { enabled: false } }),
        )
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const sessionID = await promptNewSession(host, 'Say hello.')

          for (const request of toolModel.requests) {
            expect(systemText(request)).not.toContain(BOOTSTRAP_KEY)
            expect(systemText(request)).not.toContain('<SYSTEMATIC_WORKFLOWS>')
          }
          expect(toolModel.turns.length).toBeGreaterThan(0)
          expect(await entryKeys(host, sessionID)).toEqual([])
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )

    test(
      'a second turn does not duplicate the bootstrap or announce a change',
      async () => {
        const { pluginSpec } = extractPackagedPlugin(fixture, HOST)
        const toolModel = startToolModelServer()
        const host = await startAgentHost(pluginSpec, toolModel)
        try {
          const sessionID = await promptNewSession(host, 'First turn.')
          const turnsAfterFirst = toolModel.turns.length
          await host.client.session.prompt({
            sessionID,
            text: 'Second turn.',
          })
          await host.client.session.wait({ sessionID })

          expect(toolModel.turns.length).toBeGreaterThan(turnsAfterFirst)
          const second = toolModel.turns.at(-1) as ChatRequestBody
          expect(lastUserText(second)).toContain('Second turn.')
          expect(occurrences(systemText(second), BOOTSTRAP_ENTRY)).toBe(1)
          expect(
            occurrences(systemText(second), '<SYSTEMATIC_WORKFLOWS>'),
          ).toBe(1)
          // The same value put again is no change: no update notice anywhere.
          for (const message of second.messages ?? []) {
            expect(messageText(message)).not.toContain('<system-update>')
          }
          expect(await entryKeys(host, sessionID)).toEqual([BOOTSTRAP_KEY])
        } finally {
          toolModel.stop()
          await host.server.stop()
        }
      },
      TIMEOUT_MS,
    )
  },
)
