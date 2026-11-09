import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import {
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
  },
)
