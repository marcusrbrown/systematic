import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import {
  awaitPluginsActive,
  awaitServerReady,
  buildChildEnv,
  createIsolatedFixture,
  destroyIsolatedFixture,
  type IsolatedFixture,
  startOpencodeProcess,
  stopAllOpencodeHosts,
} from '../integration/fixtures/opencode-host.js'

const BANNER = 'opencode server listening on http://127.0.0.1:4096'

type FakeFetch = typeof fetch

interface RecordedRequest {
  url: string
  headers: Record<string, string>
  hasSignal: boolean
}

/** A fetch that records each request and answers with `respond`. */
function recordingFetch(
  respond: (request: RecordedRequest) => Promise<Response> | Response,
): { fetchImpl: FakeFetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      hasSignal: init?.signal instanceof AbortSignal,
    }
    requests.push(request)
    return respond(request)
  }) as FakeFetch
  return { fetchImpl, requests }
}

/** A fetch that never answers until its signal aborts, as a stalled server would. */
function stalledFetch(): FakeFetch {
  return ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })) as FakeFetch
}

describe('awaitServerReady', () => {
  test('a v1 server is asked for its health with no credentials', async () => {
    const { fetchImpl, requests } = recordingFetch(
      () => new Response('{"healthy":true}'),
    )

    await awaitServerReady({
      announcement: { url: 'http://127.0.0.1:4096' },
      host: 'v1',
      budgetMs: 1_000,
      output: () => BANNER,
      fetchImpl,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('http://127.0.0.1:4096/global/health')
    expect(requests[0]?.headers.authorization).toBeUndefined()
    expect(requests[0]?.hasSignal).toBe(true)
  })

  test('a v2 server is asked for its info with the announced password', async () => {
    const { fetchImpl, requests } = recordingFetch(
      () => new Response('{"version":"x"}'),
    )

    await awaitServerReady({
      announcement: { url: 'http://127.0.0.1:4096', password: 's3cret' },
      host: 'v2',
      budgetMs: 1_000,
      output: () => BANNER,
      fetchImpl,
    })

    expect(requests[0]?.url).toBe('http://127.0.0.1:4096/api/info')
    expect(requests[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('opencode:s3cret').toString('base64')}`,
    )
  })

  test('a non-success response fails with the status and the captured output', async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response('nope', { status: 503 }),
    )

    const failure = awaitServerReady({
      announcement: { url: 'http://127.0.0.1:4096' },
      host: 'v1',
      budgetMs: 1_000,
      output: () => `${BANNER}\nbooting plugins`,
      fetchImpl,
    })

    await expect(failure).rejects.toThrow(/did not become ready/)
    await expect(failure).rejects.toThrow(/503/)
    await expect(failure).rejects.toThrow(/booting plugins/)
  })

  test('a refused connection fails with the cause and the captured output', async () => {
    const { fetchImpl } = recordingFetch(() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:4096')
    })

    const failure = awaitServerReady({
      announcement: { url: 'http://127.0.0.1:4096' },
      host: 'v1',
      budgetMs: 1_000,
      output: () => BANNER,
      fetchImpl,
    })

    await expect(failure).rejects.toThrow(/ECONNREFUSED/)
    await expect(failure).rejects.toThrow(/listening on/)
  })

  test('a stalled server fails within the budget instead of hanging', async () => {
    const started = Date.now()

    const failure = awaitServerReady({
      announcement: { url: 'http://127.0.0.1:4096' },
      host: 'v1',
      budgetMs: 100,
      output: () => BANNER,
      fetchImpl: stalledFetch(),
    })

    await expect(failure).rejects.toThrow(/did not become ready/)
    await expect(failure).rejects.toThrow(/100ms/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('an exhausted budget fails without making a request', async () => {
    const { fetchImpl, requests } = recordingFetch(() => new Response('ok'))

    await expect(
      awaitServerReady({
        announcement: { url: 'http://127.0.0.1:4096' },
        host: 'v1',
        budgetMs: 0,
        output: () => BANNER,
        fetchImpl,
      }),
    ).rejects.toThrow(/did not become ready/)
    expect(requests).toHaveLength(0)
  })

  test('the password never appears in the failure message', async () => {
    const failure = awaitServerReady({
      announcement: { url: 'http://127.0.0.1:4096', password: 'tOp-s3cret' },
      host: 'v2',
      budgetMs: 1_000,
      output: () => `${BANNER}\nserver password tOp-s3cret\n`,
      fetchImpl: recordingFetch(() => new Response('', { status: 500 }))
        .fetchImpl,
    })

    await expect(failure).rejects.toThrow(/did not become ready/)
    await failure.catch((error: unknown) => {
      expect(String(error)).not.toContain('tOp-s3cret')
    })
  })
})

interface PluginRow {
  id: string
  status: 'active' | 'failed'
  error?: string
}

/** A `GET /api/plugin` body: `{ data: Plugin.Info[] }`, the state on each entry. */
function pluginListResponse(rows: PluginRow[]): Response {
  return new Response(
    JSON.stringify({
      data: rows.map((row) => ({
        id: row.id,
        state:
          row.error === undefined
            ? { status: row.status }
            : { status: row.status, error: row.error },
      })),
    }),
  )
}

/** A fetch that answers with the next scripted response, repeating the last. */
function sequencedFetch(responses: Array<() => Response>): {
  fetchImpl: FakeFetch
  requests: RecordedRequest[]
} {
  let index = 0
  return recordingFetch(() => {
    const respond = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (respond === undefined) throw new Error('no scripted response')
    return respond()
  })
}

const V2_ANNOUNCEMENT = { url: 'http://127.0.0.1:4096', password: 'pw-9' }

// A v2 server answers `/api/info` as soon as it listens and loads plugins in
// the background. `/api/plugin` lists nothing until activation lands, and
// `/api/agent` and `provider.list` do not wait for it (2.4), so only this gate
// proves a plugin's agents, config transform and hooks are registered.
describe('awaitPluginsActive', () => {
  test('polls /api/plugin with the password until the expected plugin is active', async () => {
    const { fetchImpl, requests } = sequencedFetch([
      () => pluginListResponse([]),
      () => pluginListResponse([{ id: 'opencode.agent', status: 'active' }]),
      () =>
        pluginListResponse([
          { id: 'opencode.agent', status: 'active' },
          { id: 'systematic', status: 'active' },
        ]),
    ])

    await awaitPluginsActive({
      announcement: V2_ANNOUNCEMENT,
      expectedPluginIds: ['systematic'],
      budgetMs: 5_000,
      output: () => BANNER,
      fetchImpl,
      pollIntervalMs: 1,
    })

    expect(requests).toHaveLength(3)
    for (const request of requests) {
      expect(request.url).toBe('http://127.0.0.1:4096/api/plugin')
      expect(request.headers.authorization).toBe(
        `Basic ${Buffer.from('opencode:pw-9').toString('base64')}`,
      )
      expect(request.hasSignal).toBe(true)
    }
  })

  test('asks about the location a client will query, as location[directory]', async () => {
    const { fetchImpl, requests } = sequencedFetch([
      () => pluginListResponse([{ id: 'systematic', status: 'active' }]),
    ])

    await awaitPluginsActive({
      announcement: V2_ANNOUNCEMENT,
      expectedPluginIds: ['systematic'],
      location: { directory: '/tmp/work dir/project' },
      budgetMs: 5_000,
      output: () => BANNER,
      fetchImpl,
      pollIntervalMs: 1,
    })

    const url = new URL(requests[0]?.url ?? '')
    expect(url.pathname).toBe('/api/plugin')
    expect(url.searchParams.get('location[directory]')).toBe(
      '/tmp/work dir/project',
    )
  })

  test('with no expected plugin it still waits for activation to land', async () => {
    const { fetchImpl, requests } = sequencedFetch([
      () => pluginListResponse([]),
      () => pluginListResponse([{ id: 'opencode.agent', status: 'active' }]),
    ])

    await awaitPluginsActive({
      announcement: V2_ANNOUNCEMENT,
      expectedPluginIds: [],
      budgetMs: 5_000,
      output: () => BANNER,
      fetchImpl,
      pollIntervalMs: 1,
    })

    expect(requests).toHaveLength(2)
  })

  test('a failed unrelated plugin does not fail a start whose expected plugin is active', async () => {
    const { fetchImpl } = sequencedFetch([
      () =>
        pluginListResponse([
          { id: 'third-party', status: 'failed', error: 'boom' },
          { id: 'systematic', status: 'active' },
        ]),
    ])

    await awaitPluginsActive({
      announcement: V2_ANNOUNCEMENT,
      expectedPluginIds: ['systematic'],
      budgetMs: 5_000,
      output: () => BANNER,
      fetchImpl,
      pollIntervalMs: 1,
    })
  })

  test('an expected plugin listed failed fails at once, with ids and statuses only', async () => {
    const { fetchImpl, requests } = sequencedFetch([
      () =>
        pluginListResponse([
          {
            id: 'systematic',
            status: 'failed',
            error: 'Invalid Systematic config at /home/dev/secret/path',
          },
        ]),
    ])
    const started = Date.now()

    const failure = awaitPluginsActive({
      announcement: V2_ANNOUNCEMENT,
      expectedPluginIds: ['systematic'],
      budgetMs: 60_000,
      output: () => `${BANNER}\nplugin trace`,
      fetchImpl,
      pollIntervalMs: 1,
    })

    await expect(failure).rejects.toThrow(/did not become ready/)
    await expect(failure).rejects.toThrow(/systematic: failed/)
    await expect(failure).rejects.toThrow(/plugin trace/)
    await failure.catch((error: unknown) => {
      expect(String(error)).not.toContain('/home/dev/secret/path')
      expect(String(error)).not.toContain('pw-9')
    })
    expect(requests).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('a plugin that never becomes active fails within the budget, naming what was missing', async () => {
    const { fetchImpl } = sequencedFetch([
      () => pluginListResponse([{ id: 'opencode.agent', status: 'active' }]),
    ])
    const started = Date.now()

    const failure = awaitPluginsActive({
      announcement: V2_ANNOUNCEMENT,
      expectedPluginIds: ['systematic'],
      budgetMs: 150,
      output: () => `${BANNER}\nloading plugins`,
      fetchImpl,
      pollIntervalMs: 5,
    })

    await expect(failure).rejects.toThrow(/did not become ready/)
    await expect(failure).rejects.toThrow(/systematic: absent/)
    await expect(failure).rejects.toThrow(/loading plugins/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('an empty list that never fills fails within the budget', async () => {
    const { fetchImpl } = sequencedFetch([() => pluginListResponse([])])

    const failure = awaitPluginsActive({
      announcement: V2_ANNOUNCEMENT,
      expectedPluginIds: [],
      budgetMs: 100,
      output: () => BANNER,
      fetchImpl,
      pollIntervalMs: 5,
    })

    await expect(failure).rejects.toThrow(/did not become ready/)
    await expect(failure).rejects.toThrow(/no plugin was listed/)
  })

  test('a server that stalls on the plugin request fails within the budget', async () => {
    const started = Date.now()

    const failure = awaitPluginsActive({
      announcement: V2_ANNOUNCEMENT,
      expectedPluginIds: ['systematic'],
      budgetMs: 100,
      output: () => BANNER,
      fetchImpl: stalledFetch(),
      pollIntervalMs: 5,
    })

    await expect(failure).rejects.toThrow(/did not become ready/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('a transient error status is retried and a 401 is not', async () => {
    const retried = sequencedFetch([
      () => new Response('starting', { status: 503 }),
      () => pluginListResponse([{ id: 'systematic', status: 'active' }]),
    ])
    await awaitPluginsActive({
      announcement: V2_ANNOUNCEMENT,
      expectedPluginIds: ['systematic'],
      budgetMs: 5_000,
      output: () => BANNER,
      fetchImpl: retried.fetchImpl,
      pollIntervalMs: 1,
    })
    expect(retried.requests).toHaveLength(2)

    const denied = sequencedFetch([
      () => new Response('denied', { status: 401 }),
    ])
    await expect(
      awaitPluginsActive({
        announcement: V2_ANNOUNCEMENT,
        expectedPluginIds: ['systematic'],
        budgetMs: 5_000,
        output: () => BANNER,
        fetchImpl: denied.fetchImpl,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/401/)
    expect(denied.requests).toHaveLength(1)
  })

  test('an exhausted budget fails without making a request', async () => {
    const { fetchImpl, requests } = sequencedFetch([
      () => pluginListResponse([{ id: 'systematic', status: 'active' }]),
    ])

    await expect(
      awaitPluginsActive({
        announcement: V2_ANNOUNCEMENT,
        expectedPluginIds: ['systematic'],
        budgetMs: 0,
        output: () => BANNER,
        fetchImpl,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/did not become ready/)
    expect(requests).toHaveLength(0)
  })
})

// A fake launcher stands in for the OpenCode binary: it forks a long sleep
// (a stand-in for a descendant), prints a startup banner, and stays alive. The
// server the banner points at is a local Bun server the test controls.
describe.skipIf(process.platform === 'win32')(
  'startOpencodeProcess readiness',
  () => {
    const fixtures: IsolatedFixture[] = []
    const stops: Array<() => void> = []

    function makeFixture(): IsolatedFixture {
      const fixture = createIsolatedFixture()
      fixtures.push(fixture)
      return fixture
    }

    afterAll(async () => {
      await stopAllOpencodeHosts()
      for (const stop of stops) stop()
      for (const fixture of fixtures) destroyIsolatedFixture(fixture)
    })

    function writeLauncher(
      fixture: IsolatedFixture,
      banner: string,
    ): { scriptPath: string; descendantPidFile: string } {
      const scriptPath = path.join(fixture.tempRoot, 'fake-launcher.sh')
      const descendantPidFile = path.join(fixture.tempRoot, 'descendant.pid')
      fs.writeFileSync(
        scriptPath,
        [
          '#!/bin/sh',
          'sleep 300 &',
          `echo $! > ${JSON.stringify(descendantPidFile)}`,
          `printf '%s\\n' ${JSON.stringify(banner)}`,
          'wait',
          '',
        ].join('\n'),
      )
      return { scriptPath, descendantPidFile }
    }

    function startServer(
      handler: (request: Request) => Promise<Response> | Response,
    ): string {
      const server = Bun.serve({ port: 0, fetch: handler })
      stops.push(() => server.stop(true))
      return `http://127.0.0.1:${server.port}`
    }

    function isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }

    async function waitUntilGone(pid: number): Promise<boolean> {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        if (!isAlive(pid)) return true
        await Bun.sleep(25)
      }
      return !isAlive(pid)
    }

    test('resolves only once the announced server answers a request', async () => {
      const fixture = makeFixture()
      const seen: string[] = []
      const url = startServer((request) => {
        seen.push(new URL(request.url).pathname)
        return new Response('{"healthy":true}')
      })
      const { scriptPath } = writeLauncher(
        fixture,
        `opencode server listening on ${url}`,
      )

      const host = await startOpencodeProcess(
        fixture,
        '/bin/sh',
        [scriptPath],
        buildChildEnv({}),
        { host: 'v1', timeoutMs: 10_000 },
      )
      try {
        expect(host.url).toBe(url)
        expect(seen).toEqual(['/global/health'])
      } finally {
        await host.stop()
      }
    })

    test('a server that stalls after its banner fails the start and reaps the process group', async () => {
      const fixture = makeFixture()
      const url = startServer(() => new Promise<Response>(() => {}))
      const { scriptPath, descendantPidFile } = writeLauncher(
        fixture,
        `opencode server listening on ${url}`,
      )

      const failure = startOpencodeProcess(
        fixture,
        '/bin/sh',
        [scriptPath],
        buildChildEnv({}),
        { host: 'v1', timeoutMs: 600 },
      )

      await expect(failure).rejects.toThrow(/did not become ready/)
      await expect(failure).rejects.toThrow(/listening on/)
      const descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'))
      expect(Number.isInteger(descendantPid)).toBe(true)
      expect(await waitUntilGone(descendantPid)).toBe(true)
    })

    test('a server that answers with an error fails the start and reaps the process group', async () => {
      const fixture = makeFixture()
      const url = startServer(() => new Response('broken', { status: 500 }))
      const { scriptPath, descendantPidFile } = writeLauncher(
        fixture,
        `opencode server listening on ${url}`,
      )

      const failure = startOpencodeProcess(
        fixture,
        '/bin/sh',
        [scriptPath],
        buildChildEnv({}),
        { host: 'v1', timeoutMs: 10_000 },
      )

      await expect(failure).rejects.toThrow(/500/)
      const descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'))
      expect(await waitUntilGone(descendantPid)).toBe(true)
    })

    test('a failed start also kills a descendant that ignores SIGTERM', async () => {
      const fixture = makeFixture()
      const url = startServer(() => new Response('broken', { status: 500 }))
      const pidFile = path.join(fixture.tempRoot, 'stubborn.pid')
      const scriptPath = path.join(fixture.tempRoot, 'stubborn-launcher.sh')
      // The launcher itself exits on SIGTERM; its descendant ignores it and has
      // its stdio detached, so it holds none of the launcher's pipes open.
      fs.writeFileSync(
        scriptPath,
        [
          '#!/bin/sh',
          "( trap '' TERM; exec sleep 300 ) >/dev/null 2>&1 &",
          `echo $! > ${JSON.stringify(pidFile)}`,
          `printf '%s\\n' ${JSON.stringify(`opencode server listening on ${url}`)}`,
          'wait',
          '',
        ].join('\n'),
      )

      const failure = startOpencodeProcess(
        fixture,
        '/bin/sh',
        [scriptPath],
        buildChildEnv({}),
        { host: 'v1', timeoutMs: 10_000 },
      )

      await expect(failure).rejects.toThrow(/500/)
      const descendantPid = Number(fs.readFileSync(pidFile, 'utf8'))
      try {
        expect(Number.isInteger(descendantPid)).toBe(true)
        expect(await waitUntilGone(descendantPid)).toBe(true)
      } finally {
        if (isAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL')
      }
    })

    test('a v2 start sends the announced password with its request', async () => {
      const fixture = makeFixture()
      const expected = `Basic ${Buffer.from('opencode:pw-123').toString('base64')}`
      const url = startServer((request) =>
        request.headers.get('authorization') === expected &&
        new URL(request.url).pathname === '/api/info'
          ? new Response('{"version":"x"}')
          : new Response('denied', { status: 401 }),
      )
      const scriptPath = path.join(fixture.tempRoot, 'fake-v2-launcher.sh')
      fs.writeFileSync(
        scriptPath,
        [
          '#!/bin/sh',
          `printf '%s\\n' ${JSON.stringify(`server listening on ${url}`)}`,
          `printf '%s\\n' 'server password pw-123'`,
          'sleep 300',
          '',
        ].join('\n'),
      )

      const host = await startOpencodeProcess(
        fixture,
        '/bin/sh',
        [scriptPath],
        buildChildEnv({}, 'v2'),
        { host: 'v2', timeoutMs: 10_000 },
      )
      try {
        expect(host.password).toBe('pw-123')
      } finally {
        await host.stop()
      }
    })

    function writeV2Launcher(fixture: IsolatedFixture, url: string): string {
      const scriptPath = path.join(fixture.tempRoot, 'fake-v2-launcher.sh')
      fs.writeFileSync(
        scriptPath,
        [
          '#!/bin/sh',
          `printf '%s\\n' ${JSON.stringify(`server listening on ${url}`)}`,
          `printf '%s\\n' 'server password pw-123'`,
          'sleep 300',
          '',
        ].join('\n'),
      )
      return scriptPath
    }

    test('a v2 start with an expected plugin resolves only once /api/plugin lists it active', async () => {
      const fixture = makeFixture()
      let pluginPolls = 0
      const seen: string[] = []
      const locations: Array<string | null> = []
      const url = startServer((request) => {
        const { pathname, searchParams } = new URL(request.url)
        seen.push(pathname)
        if (pathname === '/api/plugin') {
          locations.push(searchParams.get('location[directory]'))
        }
        if (pathname === '/api/info') return new Response('{"version":"x"}')
        pluginPolls += 1
        return pluginPolls < 3
          ? pluginListResponse([])
          : pluginListResponse([{ id: 'systematic', status: 'active' }])
      })

      const host = await startOpencodeProcess(
        fixture,
        '/bin/sh',
        [writeV2Launcher(fixture, url)],
        buildChildEnv({}, 'v2'),
        {
          host: 'v2',
          timeoutMs: 10_000,
          expectedPluginIds: ['systematic'],
          location: { directory: fixture.projectDir },
        },
      )
      try {
        expect(seen[0]).toBe('/api/info')
        expect(locations).toEqual(
          Array.from({ length: 3 }, () => fixture.projectDir),
        )
        expect(pluginPolls).toBe(3)
      } finally {
        await host.stop()
      }
    })

    test('a v2 start whose expected plugin failed rejects with the output', async () => {
      const fixture = makeFixture()
      const url = startServer((request) =>
        new URL(request.url).pathname === '/api/info'
          ? new Response('{"version":"x"}')
          : pluginListResponse([{ id: 'systematic', status: 'failed' }]),
      )

      const failure = startOpencodeProcess(
        fixture,
        '/bin/sh',
        [writeV2Launcher(fixture, url)],
        buildChildEnv({}, 'v2'),
        { host: 'v2', timeoutMs: 10_000, expectedPluginIds: ['systematic'] },
      )

      await expect(failure).rejects.toThrow(/did not become ready/)
      await expect(failure).rejects.toThrow(/systematic: failed/)
      await expect(failure).rejects.toThrow(/listening on/)
    })
  },
)
