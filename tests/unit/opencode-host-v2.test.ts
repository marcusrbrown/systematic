import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { readOpencodeHostPin } from '../../scripts/lib/opencode-pin.js'
import {
  assertMixedVersionProbeEvents,
  buildChildEnv,
  buildIsolatedOpencodeEnv,
  buildOpencodeRunArgv,
  buildOpencodeServeArgv,
  createHostAvailabilityCache,
  createIsolatedFixture,
  createOpencodeV2Client,
  createProbePlugin,
  destroyIsolatedFixture,
  getOpencodeAvailability,
  type IsolatedFixture,
  opencodeAvailabilityReason,
  opencodeLauncherArgv,
  type ProbeEvent,
  parseServerAnnouncement,
  spawnOpencodeChild,
  startOpencodeServer,
  stopAllOpencodeHosts,
  withScriptedProvider,
  writeHostProjectConfig,
} from '../integration/fixtures/opencode-host.js'

// Versions below are sentinels: nothing here needs a real pin, and a
// realistic literal would collide with the pin-literal guard in
// opencode-pin.test.ts.
const SENTINEL_PIN = '9999.0.0'

const V2_BIN_ENV = 'SYSTEMATIC_OPENCODE_V2_BIN'
const ORIGINAL_V2_BIN = process.env[V2_BIN_ENV]

afterEach(() => {
  if (ORIGINAL_V2_BIN === undefined) {
    delete process.env[V2_BIN_ENV]
  } else {
    process.env[V2_BIN_ENV] = ORIGINAL_V2_BIN
  }
})

const fixtures: IsolatedFixture[] = []

function makeFixture(): IsolatedFixture {
  const fixture = createIsolatedFixture()
  fixtures.push(fixture)
  return fixture
}

afterAll(async () => {
  await stopAllOpencodeHosts()
  for (const fixture of fixtures) destroyIsolatedFixture(fixture)
})

// The v2 host is an installed binary named by SYSTEMATIC_OPENCODE_V2_BIN. This
// probe runs it only when that variable is set, so a plain `bun test
// tests/unit` spawns nothing and skips the block below by name. A binary that
// reports another version is not skipped: the assertions below then fail
// naming both versions.
const v2 = getOpencodeAvailability('v2')

describe.skipIf(v2.status === 'unavailable')(
  'v2 host smoke: the pinned binary under isolation',
  () => {
    test('reports the pinned version through the harness probe', () => {
      expect(opencodeAvailabilityReason('v2')).toBe(
        `@opencode/cli@${readOpencodeHostPin('v2')} is available`,
      )
      expect(v2.status).toBe('available')
      expect(v2.host).toBe('v2')
      expect(v2.reportedVersion).toBe(readOpencodeHostPin('v2'))
    })

    test('launched through the harness spawn path it prints its version and keeps every path inside the fixture', async () => {
      const fixture = makeFixture()
      const env = buildIsolatedOpencodeEnv(fixture, '{}', undefined, 'v2')
      const launcher = opencodeLauncherArgv('v2')
      const spawnOptions = {
        cwd: fixture.projectDir,
        env,
        timeoutMs: 60_000,
      }

      const version = await spawnOpencodeChild(
        [...launcher, '--version'],
        spawnOptions,
      )
      expect(version.exitCode).toBe(0)
      expect(version.stdout.trim()).toBe(
        `opencode v${readOpencodeHostPin('v2')}`,
      )

      const paths = await spawnOpencodeChild(
        [...launcher, 'debug', 'paths'],
        spawnOptions,
      )
      expect(paths.exitCode).toBe(0)
      const roots = [fixture.tempRoot, fs.realpathSync(fixture.tempRoot)]
      const rows = paths.stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter((columns) => columns.length === 2)
      const names = rows.map(([name]) => name)
      expect(names).toEqual(
        expect.arrayContaining([
          'home',
          'data',
          'cache',
          'config',
          'state',
          'tmp',
        ]),
      )
      for (const [name, location] of rows) {
        const inside = roots.some((root) => location?.startsWith(root))
        expect({ name, location, inside }).toEqual({
          name,
          location,
          inside: true,
        })
      }
    }, 90_000)

    test('serve prints its URL and password, and the remote client reads the pinned version', async () => {
      const fixture = makeFixture()
      const server = await startOpencodeServer(fixture, '{}', undefined, 'v2')
      try {
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
        expect(server.password).toBeString()

        const client = await createOpencodeV2Client(server)
        const info = await client.server.info()
        expect(info.version).toBe(readOpencodeHostPin('v2'))
      } finally {
        await server.stop()
      }
    }, 90_000)
  },
)

describe('v2 launch arguments', () => {
  test('there is no v2 launcher without a configured binary', () => {
    delete process.env[V2_BIN_ENV]

    expect(() => opencodeLauncherArgv('v2')).toThrow(new RegExp(V2_BIN_ENV))
  })

  test('the configured binary is the launcher, never bunx', () => {
    process.env[V2_BIN_ENV] = '/opt/oc/bin/opencode'

    expect(opencodeLauncherArgv('v2')).toEqual(['/opt/oc/bin/opencode'])
    expect(buildOpencodeRunArgv('v2', 'hello')[0]).toBe('/opt/oc/bin/opencode')
  })

  test('run uses --standalone so no shared service is left behind, and the prompt is the last argument', () => {
    process.env[V2_BIN_ENV] = '/opt/oc/bin/opencode'

    const argv = buildOpencodeRunArgv('v2', 'hello')

    expect(argv.slice(1, 3)).toEqual(['run', '--standalone'])
    expect(argv.at(-1)).toBe('hello')
    expect(argv).not.toContain('--model')
  })

  test('serve binds loopback on an OS-assigned port', () => {
    process.env[V2_BIN_ENV] = '/opt/oc/bin/opencode'

    expect(buildOpencodeServeArgv('v2')).toEqual([
      '/opt/oc/bin/opencode',
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '0',
    ])
  })

  test('a v1 host still launches through bunx at the v1 pin', () => {
    delete process.env.SYSTEMATIC_OPENCODE_V1_BIN

    expect(opencodeLauncherArgv('v1')).toEqual([
      'bunx',
      `opencode-ai@${readOpencodeHostPin('v1')}`,
    ])
  })
})

describe('v2 child environment and config', () => {
  test('a v2 child keeps TMPDIR in the fixture, takes no inline config, and needs no Bun cache', () => {
    const fixture = makeFixture()

    const env = buildIsolatedOpencodeEnv(fixture, '{}', undefined, 'v2')

    expect(env.TMPDIR).toBe(fixture.tmpDir)
    expect(env.HOME).toBe(fixture.homeDir)
    expect(env.OPENCODE_CONFIG_DIR).toBe(fixture.configDir)
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    expect(env.BUN_INSTALL_CACHE_DIR).toBeUndefined()
    expect(env.SYSTEMATIC_HOST_CONTRACT_KEY).toBeString()
  })

  test('a v1 child still takes its config inline and shares the Bun cache', () => {
    const fixture = makeFixture()

    const env = buildIsolatedOpencodeEnv(fixture, '{"a":1}', undefined, 'v1')

    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"a":1}')
    expect(env.BUN_INSTALL_CACHE_DIR).toContain(readOpencodeHostPin('v1'))
    expect(env.SYSTEMATIC_HOST_CONTRACT_KEY).toBeUndefined()
  })

  test('buildChildEnv only adds the Bun cache for v1', () => {
    expect(buildChildEnv({}, 'v1').BUN_INSTALL_CACHE_DIR).toBeString()
    expect(buildChildEnv({}, 'v2').BUN_INSTALL_CACHE_DIR).toBeUndefined()
  })

  test('the v2 scripted provider uses providers, a package, a top-level model and plugins', () => {
    const config = JSON.parse(
      withScriptedProvider(
        JSON.stringify({ plugin: ['/plugins/a'] }),
        'http://127.0.0.1:1/v1',
        'v2',
      ),
    ) as Record<string, unknown>

    expect(config.plugin).toBeUndefined()
    expect(config.provider).toBeUndefined()
    expect(config.plugins).toEqual(['/plugins/a'])
    expect(config.model).toBe(
      'systematic-host-contract-provider/systematic-host-contract-model',
    )
    const providers = config.providers as Record<
      string,
      Record<string, unknown>
    >
    const provider = providers['systematic-host-contract-provider']
    expect(provider?.package).toBe('@opencode/ai/providers/openai-compatible')
    expect(provider?.npm).toBeUndefined()
    expect(provider?.settings).toEqual({ baseURL: 'http://127.0.0.1:1/v1' })
    expect(provider?.env).toEqual(['SYSTEMATIC_HOST_CONTRACT_KEY'])
  })

  test('the v1 scripted provider keeps the npm shape and the plugin key', () => {
    const config = JSON.parse(
      withScriptedProvider(
        JSON.stringify({ plugin: ['file:///plugins/a'] }),
        'http://127.0.0.1:1/v1',
      ),
    ) as Record<string, unknown>

    expect(config.plugin).toEqual(['file:///plugins/a'])
    expect(config.plugins).toBeUndefined()
    expect(config.providers).toBeUndefined()
    expect(config.provider).toBeDefined()
  })

  test('a v2 project config is written to the project directory, a v1 config is not written', () => {
    const fixture = makeFixture()

    expect(writeHostProjectConfig(fixture, '{"x":1}', 'v1')).toBeUndefined()
    expect(fs.existsSync(path.join(fixture.projectDir, 'opencode.json'))).toBe(
      false,
    )

    const written = writeHostProjectConfig(fixture, '{"x":1}', 'v2')

    expect(written).toBe(path.join(fixture.projectDir, 'opencode.json'))
    expect(fs.readFileSync(written ?? '', 'utf8')).toBe('{"x":1}')
  })
})

describe('per-host availability cache', () => {
  test('asking for v1 and then v2 returns each host its own classification, computed once', () => {
    const calls: string[] = []
    const cache = createHostAvailabilityCache((host) => {
      calls.push(host)
      return {
        status: 'available',
        host,
        expectedVersion: `${SENTINEL_PIN}-${host}`,
        reportedVersion: `${SENTINEL_PIN}-${host}`,
        reason: `${host} ok`,
      }
    })

    const first = cache.get('v1')
    const second = cache.get('v2')

    expect(first.host).toBe('v1')
    expect(second.host).toBe('v2')
    expect(first.expectedVersion).not.toBe(second.expectedVersion)
    expect(cache.get('v1')).toBe(first)
    expect(cache.get('v2')).toBe(second)
    expect(calls).toEqual(['v1', 'v2'])
  })

  test('the harness classifies v2 against the v2 pin', () => {
    // v1 is deliberately not probed here: its launcher is bunx, and a unit run
    // must never spawn it.
    const classification = getOpencodeAvailability('v2')

    expect(classification.host).toBe('v2')
    expect(classification.expectedVersion).toBe(readOpencodeHostPin('v2'))
  })
})

describe('server announcement', () => {
  test('a v1 server is announced by its URL alone', () => {
    expect(
      parseServerAnnouncement(
        'opencode server listening on http://127.0.0.1:4096',
        false,
      ),
    ).toEqual({ url: 'http://127.0.0.1:4096' })
  })

  test('a v2 server is announced only once its password has arrived too', () => {
    const urlOnly = 'server listening on http://127.0.0.1:4096\n'

    expect(parseServerAnnouncement(urlOnly, true)).toBeUndefined()
    expect(
      parseServerAnnouncement(`${urlOnly}server password s3cret\n`, true),
    ).toEqual({ url: 'http://127.0.0.1:4096', password: 's3cret' })
  })

  test('nothing is announced before a URL appears', () => {
    expect(parseServerAnnouncement('starting...', false)).toBeUndefined()
    expect(parseServerAnnouncement('server password abc', true)).toBeUndefined()
  })
})

describe('v2 probe plugin and system assertion', () => {
  function chatEvent(system: string[]): ProbeEvent {
    return { type: 'system', kind: 'chat', input: {}, system }
  }

  test('the v2 probe is a plugin object the host lists by directory path', () => {
    const fixture = makeFixture()

    const probe = createProbePlugin(fixture, 'v2')

    expect(probe.spec).not.toStartWith('file:')
    expect(probe.url).toStartWith('file:')
    const source = fs.readFileSync(path.join(probe.spec, 'index.js'), 'utf8')
    expect(source).toContain('export default {')
    expect(source).toContain("ctx.session.hook('context'")
    const manifest = JSON.parse(
      fs.readFileSync(path.join(probe.spec, 'package.json'), 'utf8'),
    ) as { exports?: Record<string, string> }
    expect(manifest.exports?.['.']).toBe('./index.js')
  })

  test('the v1 probe is listed by file URL', () => {
    const fixture = makeFixture()

    const probe = createProbePlugin(fixture, 'v1')

    expect(probe.spec).toBe(probe.url)
  })

  test('a v2 workflow block need not be the first system entry', () => {
    const events = [
      chatEvent([
        '<env>host preamble</env>',
        '<SYSTEMATIC_WORKFLOWS>\nbody\n</SYSTEMATIC_WORKFLOWS>',
      ]),
    ]

    expect(() => assertMixedVersionProbeEvents(events, 'v2')).not.toThrow()
    expect(() => assertMixedVersionProbeEvents(events, 'v1')).toThrow(
      /not first system entry/,
    )
  })

  test('a doubled v2 workflow block is rejected', () => {
    const block = '<SYSTEMATIC_WORKFLOWS>\nbody\n</SYSTEMATIC_WORKFLOWS>'

    expect(() =>
      assertMixedVersionProbeEvents([chatEvent([block, block])], 'v2'),
    ).toThrow(/exactly one opening and one closing marker/)
  })

  test('a v2 block that never closes is rejected', () => {
    expect(() =>
      assertMixedVersionProbeEvents(
        [chatEvent(['<SYSTEMATIC_WORKFLOWS>\nbody'])],
        'v2',
      ),
    ).toThrow(/exactly one opening and one closing marker/)
  })

  test('v2 markers out of order are rejected', () => {
    expect(() =>
      assertMixedVersionProbeEvents(
        [chatEvent(['</SYSTEMATIC_WORKFLOWS>\nbody\n<SYSTEMATIC_WORKFLOWS>'])],
        'v2',
      ),
    ).toThrow(/out of order/)
  })
})
