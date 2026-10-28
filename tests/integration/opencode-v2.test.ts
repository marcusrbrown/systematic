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
import {
  buildIsolatedOpencodeEnv,
  buildOpencodeRunArgv,
  cleanupPackedTarball,
  createIsolatedFixture,
  destroyIsolatedFixture,
  extractPackagedPlugin,
  getOpencodeAvailability,
  type IsolatedFixture,
  isOpencodeAvailable,
  opencodeAvailabilityReason,
  packTarballOnce,
  type ScriptedModelServer,
  scriptedResponseChunks,
  spawnOpencodeChild,
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
  },
)
