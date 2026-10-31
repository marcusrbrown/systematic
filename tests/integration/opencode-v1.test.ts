// The OpenCode v1 behaviors that have no v2 counterpart, run by the two v1
// host jobs only:
//   - the packaged plugin's catalog is read from the v1 `tool.definition`
//     hook, and a rejected config is read from v1's `debug config` command.
//     The v2 equivalents (the catalog the model is offered, and a config that
//     fails the plugin load) live in opencode-v2.test.ts.
//   - the mixed-version test loads a published release next to the local
//     source, and that release only loads on v1.
// Nothing here may skip on a v2 host; the profile lists keep this file off it.

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
import { SEARCH_ERRORS } from '../../src/lib/search-core.js'
import {
  assertDelegatedSearchProof,
  type ChatRequest,
  createDelegatedSearchScript,
  type DelegatedSearchScript,
  evaluateDelegatedSearchProof,
  hasResearcherSystemMarker,
  plantDelegatedSearchFixture,
  researcherSystemMarker,
} from '../helpers/delegated-search-proof.js'
import {
  assertMixedVersionProbeEvents,
  assertOk,
  assertProbeCapturedEvents,
  buildIsolatedOpencodeEnv,
  buildOpencodeRunArgv,
  cleanupPackedTarball,
  createIsolatedFixture,
  createProbePlugin,
  destroyIsolatedFixture,
  EXACT_OPENCODE_VERSION,
  extractPackagedPlugin,
  getOpencodeAvailability,
  type IsolatedFixture,
  isOpencodeAvailable,
  isProbeToolEvent,
  MAX_RETRIES,
  type OpencodeResult,
  opencodeAvailabilityReason,
  packTarballOnce,
  REPO_ROOT,
  runOpencode,
  type ScriptedModelServer,
  scriptedResponseChunks,
  spawnOpencodeChild,
  TARGET_OPENCODE_HOST,
  TIMEOUT_MS,
  withScriptedProvider,
} from './fixtures/opencode-host.js'

// This call lives here rather than in the fixture module, so importing the
// fixture never spawns the launcher at module scope (see
// tests/unit/opencode-host-no-spawn.test.ts).
requireOpencodeAvailable(getOpencodeAvailability())
if (!isOpencodeAvailable()) {
  console.warn(
    `[systematic] skipping OpenCode-dependent tests in opencode-v1.test.ts: ${opencodeAvailabilityReason()}`,
  )
}

// The host's own tool-invocation log line, produced only if OpenCode actually
// dispatched the scripted `systematic_skill` call with the expected skill name.
function expectSetupSkillLoaded(result: OpencodeResult): void {
  assertOk(result)
  expect(result.stderr).toMatch(
    /(?:Skill\s+"?git-clean-gone-branches"?|systematic_skill\s*\{"name":"(?:systematic:)?git-clean-gone-branches"\})/i,
  )
}

interface ScriptedToolRun {
  tool: string
  args: Record<string, unknown>
  /** Runs the call as this agent; omitted runs the host's default agent. */
  agent?: string
}

function toolMessageText(message: unknown): string {
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

/**
 * A scripted model that makes one tool call and reads the answer. The text of
 * the first tool result the host sent back is `result()`; it is empty when the
 * host never ran the call.
 */
function startToolCallModel(call: ScriptedToolRun): ScriptedModelServer & {
  result(): string
} {
  let issued = false
  let toolResult = ''
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
        messages?: { role?: string }[]
      }
      const toolMessage = body.messages?.find((m) => m.role === 'tool')
      if (toolMessage !== undefined && toolResult === '') {
        toolResult = toolMessageText(toolMessage)
      }
      const offersTools = Array.isArray(body.tools) && body.tools.length > 0
      const response =
        offersTools && !issued && toolMessage === undefined
          ? {
              toolCalls: [
                { id: 'v1-skill-call', name: call.tool, arguments: call.args },
              ],
            }
          : { text: 'done' }
      if (response.toolCalls) issued = true
      const chunks = scriptedResponseChunks(
        response,
        'v1-skill-response',
        Math.floor(Date.now() / 1000),
      )
      const encoder = new TextEncoder()
      const sse = [
        ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
        'data: [DONE]\n\n',
      ].join('')
      return new Response(encoder.encode(sse), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
    result: () => toolResult,
  }
}

/**
 * Runs one scripted tool call through a real v1 host with the packaged plugin
 * and returns what the tool answered. The host's own permission check sits in
 * front of the tool, so a refusal comes back as the host's refusal text.
 */
async function callToolOnHost(
  fixture: IsolatedFixture,
  pluginUrl: string,
  call: ScriptedToolRun,
): Promise<string> {
  const model = startToolCallModel(call)
  try {
    const configContent = withScriptedProvider(
      JSON.stringify({ plugin: [pluginUrl], snapshot: false }),
      model.url,
    )
    const argv = buildOpencodeRunArgv(
      TARGET_OPENCODE_HOST,
      'run the scripted call',
    )
    const prompt = argv.pop()
    if (prompt === undefined) throw new Error('run argv has no prompt')
    if (call.agent !== undefined) argv.push('--agent', call.agent)
    argv.push(prompt)
    const result = await spawnOpencodeChild(argv, {
      cwd: fixture.projectDir,
      env: buildIsolatedOpencodeEnv(fixture, configContent),
      timeoutMs: TIMEOUT_MS,
    })
    assertOk(result)
    return model.result()
  } finally {
    model.stop()
  }
}

/**
 * A scripted model that answers every request from a delegated-search script
 * and keeps no state of its own. The script decides each turn from the request.
 */
function startDelegatedSearchModel(
  script: DelegatedSearchScript,
): ScriptedModelServer {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        !request.url.endsWith('/chat/completions')
      ) {
        return new Response('not found', { status: 404 })
      }
      const body = (await request.json()) as ChatRequest
      const chunks = scriptedResponseChunks(
        script.respond(body),
        'v1-delegated-search-response',
        Math.floor(Date.now() / 1000),
      )
      const sse = [
        ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
        'data: [DONE]\n\n',
      ].join('')
      return new Response(new TextEncoder().encode(sse), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

/**
 * Runs the parent through `opencode run`, with the scripted parent dispatching
 * the learnings researcher by `task`. Returns what the run printed and what
 * the model saw. The researcher child is told apart from the parent by the
 * researcher's own opening line, read from its agent file.
 */
async function runDelegatedSearch(
  fixture: IsolatedFixture,
  pluginUrl: string,
): Promise<{ result: OpencodeResult; script: DelegatedSearchScript }> {
  plantDelegatedSearchFixture(fixture.projectDir)
  const marker = researcherSystemMarker(REPO_ROOT)
  const script = createDelegatedSearchScript({
    dispatch: {
      tool: 'task',
      arguments: {
        description: 'Search past solutions',
        prompt: 'Find the zebra flake solution.',
        subagent_type: 'learnings-researcher',
      },
    },
    isChildRequest: (request) => hasResearcherSystemMarker(request, marker),
  })
  const model = startDelegatedSearchModel(script)
  try {
    const configContent = withScriptedProvider(
      JSON.stringify({ plugin: [pluginUrl], snapshot: false }),
      model.url,
    )
    const result = await spawnOpencodeChild(
      buildOpencodeRunArgv(
        TARGET_OPENCODE_HOST,
        'Dispatch the learnings researcher to find the zebra flake solution.',
      ),
      {
        cwd: fixture.projectDir,
        env: buildIsolatedOpencodeEnv(fixture, configContent),
        timeoutMs: TIMEOUT_MS,
      },
    )
    return { result, script }
  } finally {
    model.stop()
  }
}

/**
 * Model-free `opencode debug config` invocation, isolated the same way as
 * `runOpencode`. Routed through `spawnOpencodeChild` (not `Bun.spawnSync`)
 * for the same reason `runOpencode` is: `Bun.spawnSync` signals only the
 * direct `bunx` process on timeout, leaving a `opencode-ai` grandchild
 * orphaned; `spawnOpencodeChild` reaps the whole process group instead.
 */
async function runOpencodeDebugConfig(
  fixture: IsolatedFixture,
  configContent: string,
): Promise<OpencodeResult> {
  const childEnv = buildIsolatedOpencodeEnv(fixture, configContent)
  return spawnOpencodeChild(
    [
      'bunx',
      `opencode-ai@${EXACT_OPENCODE_VERSION}`,
      'debug',
      'config',
      '--print-logs',
      '--log-level',
      'ERROR',
    ],
    { cwd: fixture.projectDir, env: childEnv, timeoutMs: TIMEOUT_MS },
  )
}

// Requires real `tar` and symlink semantics for artifact extraction; POSIX only.
describe.skipIf(!isOpencodeAvailable() || process.platform === 'win32')(
  'packaged-plugin runtime validation',
  () => {
    let fixture: IsolatedFixture

    beforeAll(() => {
      packTarballOnce()
    }, 200_000)

    afterAll(() => {
      cleanupPackedTarball()
    })

    beforeEach(() => {
      fixture = createIsolatedFixture()
    })

    afterEach(() => {
      destroyIsolatedFixture(fixture)
    })

    // Runs against `runOpencode`'s scripted local provider (no network,
    // no hosted-model dependency); see fixtures/opencode-host.ts.
    test(
      'packaged plugin loads, warns on a removed disabled_skills name, and exposes a compliant catalog',
      async () => {
        const probe = createProbePlugin(fixture)
        const { pluginUrl } = extractPackagedPlugin(fixture)
        fs.mkdirSync(path.join(fixture.projectDir, '.opencode'), {
          recursive: true,
        })
        fs.writeFileSync(
          path.join(fixture.projectDir, '.opencode/systematic.json'),
          JSON.stringify({ disabled_skills: ['orchestrating-swarms'] }),
        )
        const configContent = JSON.stringify({
          plugin: [pluginUrl, probe.url],
        })

        const result = await runOpencode(
          'Use the systematic_skill tool to load systematic:git-clean-gone-branches',
          { fixture, configContent },
        )

        // Tool actually being invoked and its output surfacing proves the
        // packaged plugin's hooks registered and ran startup successfully.
        expectSetupSkillLoaded(result)
        expect(result.stderr).toContain(
          '[systematic] "orchestrating-swarms" in `disabled_skills` is no longer a bundled name and will be ignored.',
        )

        const events = assertProbeCapturedEvents(probe)
        const toolEvents = events.filter(isProbeToolEvent)
        expect(toolEvents.length).toBeGreaterThan(0)
        for (const event of toolEvents) {
          expect(event.description).toContain(
            'systematic:orchestrating-subagents',
          )
          expect(event.description).not.toContain(
            'systematic:orchestrating-swarms',
          )
          expect(event.description).not.toContain(
            'systematic:claude-permissions-optimizer',
          )
        }
      },
      TIMEOUT_MS * MAX_RETRIES,
    )

    test(
      'packaged plugin rejects an unrecognized disabled_skills name, model-free',
      async () => {
        const { pluginUrl } = extractPackagedPlugin(fixture)
        fs.mkdirSync(path.join(fixture.projectDir, '.opencode'), {
          recursive: true,
        })
        fs.writeFileSync(
          path.join(fixture.projectDir, '.opencode/systematic.json'),
          JSON.stringify({ disabled_skills: ['never-existed-skill'] }),
        )
        const configContent = JSON.stringify({ plugin: [pluginUrl] })

        const result = await runOpencodeDebugConfig(fixture, configContent)

        // OpenCode 1.17.18 host contract: plugin-factory rejections are
        // caught and logged, hooks omitted, host exits 0
        // (.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/plugin/index.ts:219-235).
        // Asserting exitCode === 0 (not just log content) prevents a hang
        // or crash from silently passing.
        expect(result.exitCode).toBe(0)
        expect(result.stderr).toContain('failed to load plugin')
        expect(result.stderr).toContain('Invalid Systematic config in')
      },
      TIMEOUT_MS,
    )

    // The two skill tools ask for permission under different names on v1: the
    // native `skill` tool asks with the bare name, `systematic_skill` with
    // `systematic:<name>`. These two tests run both through the real host.
    test(
      'systematic_skill refuses a skill a managed agent may not load while the listed skill and a sibling agent load',
      async () => {
        const { pluginUrl } = extractPackagedPlugin(fixture)
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

        const allowed = await callToolOnHost(fixture, pluginUrl, {
          tool: 'systematic_skill',
          args: { name: 'git-worktree' },
          agent: 'repo-research-analyst',
        })
        const denied = await callToolOnHost(fixture, pluginUrl, {
          tool: 'systematic_skill',
          args: { name: 'git-clean-gone-branches' },
          agent: 'repo-research-analyst',
        })
        const native = await callToolOnHost(fixture, pluginUrl, {
          tool: 'skill',
          args: { name: 'git-worktree' },
          agent: 'repo-research-analyst',
        })
        const sibling = await callToolOnHost(fixture, pluginUrl, {
          tool: 'systematic_skill',
          args: { name: 'git-clean-gone-branches' },
          agent: 'correctness-reviewer',
        })

        expect(allowed).toContain(
          '<skill_content name="systematic:git-worktree">',
        )
        expect(denied).not.toContain('<skill_content')
        expect(denied.toLowerCase()).toContain('rule')
        // The native tool keeps working for the listed skill.
        expect(native).toContain('<skill_content name="git-worktree">')
        expect(sibling).toContain(
          '<skill_content name="systematic:git-clean-gone-branches">',
        )
      },
      TIMEOUT_MS * 4,
    )

    test(
      'an explicit systematic: deny is kept when a hand-written bare allow wins over a category skills list',
      async () => {
        const { pluginUrl } = extractPackagedPlugin(fixture)
        fs.writeFileSync(
          path.join(fixture.configDir, 'systematic.json'),
          JSON.stringify({
            categories: { review: { skills: ['git-worktree'] } },
            agents: {
              'correctness-reviewer': {
                mode: 'primary',
                permission: {
                  skill: {
                    'systematic:git-worktree': 'deny',
                    'git-worktree': 'allow',
                  },
                },
              },
            },
          }),
        )

        const viaSystematic = await callToolOnHost(fixture, pluginUrl, {
          tool: 'systematic_skill',
          args: { name: 'git-worktree' },
          agent: 'correctness-reviewer',
        })
        const viaNative = await callToolOnHost(fixture, pluginUrl, {
          tool: 'skill',
          args: { name: 'git-worktree' },
          agent: 'correctness-reviewer',
        })

        // The user's prefixed deny still refuses systematic_skill ...
        expect(viaSystematic).not.toContain('<skill_content')
        expect(viaSystematic.toLowerCase()).toContain('rule')
        // ... and the bare allow still lets the native tool load the skill.
        expect(viaNative).toContain('<skill_content name="git-worktree">')
      },
      TIMEOUT_MS * 2,
    )
    test(
      'the native skill tool refuses a skill in disabled_skills, and still loads an enabled one',
      async () => {
        const { pluginUrl } = extractPackagedPlugin(fixture)
        fs.mkdirSync(path.join(fixture.projectDir, '.opencode'), {
          recursive: true,
        })
        fs.writeFileSync(
          path.join(fixture.projectDir, '.opencode/systematic.json'),
          JSON.stringify({ disabled_skills: ['git-worktree'] }),
        )

        const refused = await callToolOnHost(fixture, pluginUrl, {
          tool: 'skill',
          args: { name: 'git-worktree' },
        })
        const control = await callToolOnHost(fixture, pluginUrl, {
          tool: 'skill',
          args: { name: 'git-clean-gone-branches' },
        })

        expect(refused).not.toContain('<skill_content')
        expect(refused.toLowerCase()).toContain('rule')
        expect(control).toContain(
          '<skill_content name="git-clean-gone-branches">',
        )
      },
      TIMEOUT_MS * 2,
    )

    // A successful call proves the tool registered, so this leg does not
    // assert the offered tool names (the helper returns only the result text).
    // It is also the proof that the host's tool context carries `directory`,
    // on the floor lane too: the adapter has no other directory to use, so the
    // tool finds the document only when `context.directory` is the project.
    test(
      'systematic_search finds a document under the host project, and limit 0 and 21 reach the core',
      async () => {
        const { pluginUrl } = extractPackagedPlugin(fixture)
        fs.mkdirSync(path.join(fixture.projectDir, 'docs/solutions'), {
          recursive: true,
        })
        fs.writeFileSync(
          path.join(fixture.projectDir, 'docs/solutions/zebra-flake.md'),
          '---\ntitle: Zebra crossing flake\nsymptoms:\n  - zebra flake on retry\n---\n\nThe zebra flake appears when retries overlap.\n',
        )

        const found = await callToolOnHost(fixture, pluginUrl, {
          tool: 'systematic_search',
          args: { query: 'zebra flake retry' },
        })
        const zero = await callToolOnHost(fixture, pluginUrl, {
          tool: 'systematic_search',
          args: { query: 'zebra flake retry', limit: 0 },
        })
        const tooMany = await callToolOnHost(fixture, pluginUrl, {
          tool: 'systematic_search',
          args: { query: 'zebra flake retry', limit: 21 },
        })

        expect(found).toContain('docs/solutions/zebra-flake.md')
        expect(found).toContain('Zebra crossing flake')
        // Recorded behavior: the v1 host passes an out-of-range integer
        // through, so the core's fixed error is what the model sees.
        expect(zero).toContain(SEARCH_ERRORS.limitInvalid)
        expect(tooMany).toContain(SEARCH_ERRORS.limitInvalid)
      },
      TIMEOUT_MS * 3,
    )

    // The parent dispatches the researcher through `task`, the child calls
    // the plugin's search tool, and the result travels back to the parent.
    // Runs on the floor and current lanes alike.
    test(
      'a dispatched learnings-researcher child calls systematic_search and its result reaches the parent',
      async () => {
        const { pluginUrl } = extractPackagedPlugin(fixture)

        const { result, script } = await runDelegatedSearch(fixture, pluginUrl)

        assertOk(result)
        // `opencode run` prints the parent's final message and nothing else
        // on stdout, so stdout is that one message. The proof requires it to
        // carry the parent's marker and both planted paths.
        assertDelegatedSearchProof({
          ...script.observation(),
          parentAnswer: result.stdout.trim(),
        })
      },
      TIMEOUT_MS * 2,
    )

    test(
      'with search.enabled false the researcher child is not offered the tool and the proof fails saying so',
      async () => {
        const { pluginUrl } = extractPackagedPlugin(fixture)
        fs.writeFileSync(
          path.join(fixture.configDir, 'systematic.json'),
          JSON.stringify({ search: { enabled: false } }),
        )

        const { result, script } = await runDelegatedSearch(fixture, pluginUrl)

        assertOk(result)
        const verdict = evaluateDelegatedSearchProof(script.observation())
        expect(verdict).toMatchObject({
          ok: false,
          code: 'tool-not-advertised',
        })
        if (!verdict.ok) {
          expect(verdict.message).toContain(
            'did not advertise systematic_search',
          )
        }
        // The child was reached, so the failure is the missing tool, not a
        // dispatch that never happened.
        expect(script.observation().childRequests.length).toBeGreaterThan(0)
      },
      TIMEOUT_MS * 2,
    )
  },
)

const MIXED_VERSION_ENABLED = process.env.SYSTEMATIC_MIXED_VERSION_TEST === '1'

function buildMixedVersionConfig(probePluginUrl: string): string {
  // Pin the published package to a known-good OpenCode integration surface;
  // bump this only when intentionally revalidating a newer release here.
  const pinnedPackage = '@fro.bot/systematic@2.14.1'
  const localSource = `file://${path.join(REPO_ROOT, 'src/index.ts')}`
  return JSON.stringify({
    plugin: [pinnedPackage, localSource, probePluginUrl],
  })
}

describe.skipIf(!isOpencodeAvailable())(
  'opencode mixed-version integration',
  () => {
    let fixture: IsolatedFixture

    beforeEach(() => {
      fixture = createIsolatedFixture()
    })

    afterEach(() => {
      destroyIsolatedFixture(fixture)
    })

    test.skipIf(!MIXED_VERSION_ENABLED)(
      'pinned package plus local source keep systematic_skill deterministic and converge bootstrap',
      async () => {
        const probe = createProbePlugin(fixture)
        const result = await runOpencode(
          'Use the systematic_skill tool to load ce:review',
          {
            fixture,
            configContent: buildMixedVersionConfig(probe.url),
            extraEnv: {
              npm_config_cache: path.join(fixture.tempRoot, 'npm-cache'),
              npm_config_prefix: path.join(fixture.tempRoot, 'npm-prefix'),
            },
          },
        )

        assertOk(result)
        expect(result.stderr).toMatch(/systematic_skill/)
        expect(result.stdout).toMatch(/ce:review/i)

        const events = assertProbeCapturedEvents(probe)

        assertMixedVersionProbeEvents(events)

        const toolEvents = events.filter(isProbeToolEvent)
        expect(toolEvents.length).toBeGreaterThanOrEqual(2)
        expect(new Set(toolEvents.map((event) => event.description)).size).toBe(
          1,
        )
        expect(
          new Set(toolEvents.map((event) => JSON.stringify(event.parameters)))
            .size,
        ).toBe(1)
        for (const event of toolEvents) {
          expect(event.description).toContain('## Available Systematic Skills')
          expect(event.description).toMatch(
            /ce:brainstorm|systematic:git-clean-gone-branches/,
          )
          expect(event.description).not.toContain('<available_skills>')
          expect(event.description).not.toContain('<location>')
        }
      },
      TIMEOUT_MS * MAX_RETRIES,
    )
  },
)
