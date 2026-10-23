import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const SCRIPT_PATH = path.join(
  ROOT_DIR,
  'skills/pr-attachments/scripts/pr-attachments.mjs',
)

const CANARY = 'SECRET-CANARY-5be21f08'
const SHA = 'a'.repeat(40)

function embedUrl(name: string, host = 'raw.githubusercontent.com'): string {
  return `https://${host}/octo/repo/${SHA}/docs/evidence/demo/${name}`
}

const A_PNG = embedUrl('a.png')
const B_PNG = embedUrl('b.png')
const C_PNG = embedUrl('c.png')

// ── Helper module, loaded in-process ───────────────────────────────────────

interface UrlResult {
  readonly url: string
  readonly status: string
  readonly http_status: number | null
  readonly attempts: number
  readonly retryable: boolean
}

interface VerifyReport {
  readonly schema_version: number
  readonly operation: string
  readonly result: string
  readonly checked: number
  readonly passed: number
  readonly waited_s: number
  readonly retryable: boolean
  readonly results: readonly UrlResult[]
  readonly failed: readonly UrlResult[]
  readonly error?: string
  readonly usage?: string
}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>

interface VerifyOptions {
  readonly fetch?: FetchFn
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly random?: () => number
  readonly startTimer?: (ms: number, fire: () => void) => () => void
  readonly scheduleMs?: readonly number[]
  readonly maxAttempts?: number
  readonly maxWaitMs?: number
  readonly waitedMs?: number
  readonly totalBudgetMs?: number
  readonly requestTimeoutMs?: number
  readonly isAllowedTarget?: (target: URL) => boolean
}

interface Helper {
  verifyUrls(
    urls: readonly string[],
    options?: VerifyOptions,
  ): Promise<{ results: UrlResult[]; waitedMs: number }>
  runVerify(
    raw: unknown,
    options?: VerifyOptions,
  ): Promise<{ exitCode: number; body: VerifyReport }>
}

async function loadHelper(): Promise<Helper> {
  return (await import(pathToFileURL(SCRIPT_PATH).href)) as Helper
}

// ── Virtual time: nothing here waits on a real clock ───────────────────────

interface Timer {
  readonly at: number
  readonly fire: () => void
  live: boolean
}

function makeClock() {
  let time = 0
  const timers: Timer[] = []
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => time,
    sleep: (ms: number) => {
      sleeps.push(ms)
      return new Promise<void>((resolve) => {
        timers.push({ at: time + ms, fire: resolve, live: true })
      })
    },
    startTimer: (ms: number, fire: () => void) => {
      const timer: Timer = { at: time + ms, fire, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    },
    /** Lets the work run, jumping time to the next timer whenever it blocks. */
    async run<T>(work: Promise<T>): Promise<T> {
      let done = false
      const settled = work.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      void settled.then(() => {
        done = true
      })
      while (!done) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (done) {
          break
        }
        const next = timers
          .filter((timer) => timer.live)
          .sort((left, right) => left.at - right.at)[0]
        if (next === undefined) {
          throw new Error('deadlock: the work is blocked with no timer pending')
        }
        next.live = false
        time = Math.max(time, next.at)
        next.fire()
      }
      const outcome = await settled
      if (!outcome.ok) {
        throw outcome.error
      }
      return outcome.value
    },
  }
}

// ── Scripted fetch and response doubles ────────────────────────────────────

const HANG = Symbol('hang')
type Step = Response | Error | typeof HANG

interface Probe {
  reads: number
  cancels: number
}

let probes: Probe[] = []

/**
 * A response that records whether anything tried to read its body. Only the
 * status, the headers and `body.cancel()` may be used.
 */
function reply(
  status: number,
  headers: Record<string, string> = {},
  type: string | null = 'image/png',
): Response {
  const probe: Probe = { reads: 0, cancels: 0 }
  probes.push(probe)
  const read = () => {
    probe.reads += 1
    return Promise.reject(new Error(`body read: ${CANARY}`))
  }
  const double = {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({
      ...(type === null ? {} : { 'content-type': type }),
      ...headers,
    }),
    body: {
      cancel: () => {
        probe.cancels += 1
        return Promise.resolve()
      },
      getReader: read,
      tee: read,
    },
    text: read,
    json: read,
    arrayBuffer: read,
    blob: read,
    bytes: read,
    formData: read,
  }
  return double as unknown as Response
}

const ok = (type = 'image/png') => reply(200, {}, type)
const redirectTo = (location: string, status = 302) =>
  reply(status, { location }, null)

interface Call {
  readonly url: string
  readonly init: RequestInit
}

function makeFetch(handler: (url: string, nth: number) => Step) {
  const calls: Call[] = []
  const fetchFn: FetchFn = (input, init) => {
    const nth = calls.filter((call) => call.url === input).length
    calls.push({ url: input, init })
    const step = handler(input, nth)
    if (step === HANG) {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step)
  }
  return { calls, fetchFn }
}

/** Replies from a list, one step per call to that URL; the last step repeats. */
function sequence(...steps: Array<() => Step>) {
  return (_url: string, nth: number): Step => {
    const step = steps[Math.min(nth, steps.length - 1)]
    if (step === undefined) {
      throw new Error('empty script')
    }
    return step()
  }
}

beforeEach(() => {
  probes = []
})

function optionsFor(
  clock: ReturnType<typeof makeClock>,
  fetchFn: FetchFn,
  extra: VerifyOptions = {},
): VerifyOptions {
  return {
    fetch: fetchFn,
    sleep: clock.sleep,
    now: clock.now,
    startTimer: clock.startTimer,
    random: () => 0.5,
    ...extra,
  }
}

async function verify(
  urls: readonly string[],
  handler: (url: string, nth: number) => Step,
  extra: VerifyOptions = {},
) {
  const helper = await loadHelper()
  const clock = makeClock()
  const { calls, fetchFn } = makeFetch(handler)
  const done = await clock.run(
    helper.verifyUrls(urls, optionsFor(clock, fetchFn, extra)),
  )
  return { ...done, calls, clock }
}

async function verifyOne(
  handler: (url: string, nth: number) => Step,
  extra: VerifyOptions = {},
) {
  const done = await verify([A_PNG], handler, extra)
  const result = done.results[0]
  if (result === undefined) {
    throw new Error('expected one result')
  }
  return { ...done, result }
}

// ── Passing and what a request looks like ──────────────────────────────────

describe('verify: a served image passes', () => {
  it('passes a 200 image/png on the first attempt without waiting', async () => {
    const { result, clock, calls } = await verifyOne(() => ok())

    expect(result).toEqual({
      url: A_PNG,
      status: 'ok',
      http_status: 200,
      attempts: 1,
      retryable: false,
    })
    expect(clock.sleeps).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('reads the content type without regard to case or parameters', async () => {
    const { result } = await verifyOne(() => ok('Image/WebP; charset=binary'))

    expect(result.status).toBe('ok')
  })

  it('asks with GET, no credentials and manual redirects', async () => {
    const { calls } = await verifyOne(() => ok())

    const init = calls[0]?.init
    expect(init?.method).toBe('GET')
    expect(init?.redirect).toBe('manual')
    expect(init?.credentials).toBe('omit')
    const headers = new Headers(init?.headers)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
  })

  it('checks a URL given twice once', async () => {
    const { results, calls } = await verify([A_PNG, A_PNG], () => ok())

    expect(results).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })
})

// ── Retry ──────────────────────────────────────────────────────────────────

describe('verify: retry schedule', () => {
  it('passes a 404 that turns into a 200, waiting 2 s then 4 s', async () => {
    const { result, clock } = await verifyOne(
      sequence(
        () => reply(404, {}, 'text/plain'),
        () => reply(404, {}, 'text/plain'),
        () => ok(),
      ),
    )

    expect(result.status).toBe('ok')
    expect(result.attempts).toBe(3)
    expect(clock.sleeps).toEqual([2000, 4000])
  })

  it('walks 2/4/8/15 s then repeats 30 s until 300 s, then fails for good', async () => {
    const { result, clock } = await verifyOne(
      () => reply(404, {}, 'text/plain'),
      { maxWaitMs: 300_000 },
    )

    expect(clock.sleeps).toEqual([
      2000, 4000, 8000, 15_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000,
      30_000, 30_000, 30_000,
    ])
    expect(result).toEqual({
      url: A_PNG,
      status: 'not-found',
      http_status: 404,
      attempts: 14,
      retryable: false,
    })
  })

  it('stops a persistent 404 at the per-call wait with a retryable failure', async () => {
    const { result, clock, waitedMs } = await verifyOne(() =>
      reply(404, {}, 'text/plain'),
    )

    expect(clock.sleeps).toEqual([2000, 4000, 8000, 15_000, 30_000, 30_000])
    expect(result.status).toBe('not-found')
    expect(result.attempts).toBe(7)
    expect(result.retryable).toBe(true)
    expect(waitedMs).toBe(89_000)
  })

  it('applies ±20% jitter to the scheduled wait', async () => {
    const low = await verifyOne(
      sequence(
        () => reply(404, {}, null),
        () => ok(),
      ),
      { random: () => 0 },
    )
    const high = await verifyOne(
      sequence(
        () => reply(404, {}, null),
        () => ok(),
      ),
      { random: () => 1 },
    )

    expect(low.clock.sleeps).toEqual([1600])
    expect(high.clock.sleeps).toEqual([2400])
  })

  it('waits for a 429 Retry-After longer than the schedule', async () => {
    const { result, clock } = await verifyOne(
      sequence(
        () => reply(429, { 'retry-after': '7' }, null),
        () => ok(),
      ),
    )

    expect(result.status).toBe('ok')
    expect(clock.sleeps).toEqual([7000])
  })

  it('keeps the scheduled wait when Retry-After is shorter', async () => {
    const { clock } = await verifyOne(
      sequence(
        () => reply(429, { 'retry-after': '1' }, null),
        () => ok(),
      ),
    )

    expect(clock.sleeps).toEqual([2000])
  })

  it('ignores a Retry-After it cannot read as seconds', async () => {
    const { clock } = await verifyOne(
      sequence(
        () => reply(429, { 'retry-after': 'soon' }, null),
        () => ok(),
      ),
    )

    expect(clock.sleeps).toEqual([2000])
  })

  it('stops at once, retryable, when Retry-After is past the call budget', async () => {
    const { result, clock } = await verifyOne(
      () => reply(429, { 'retry-after': '120' }, null),
      { maxWaitMs: 90_000 },
    )

    expect(clock.sleeps).toEqual([])
    expect(result.status).toBe('rate-limited')
    expect(result.http_status).toBe(429)
    expect(result.attempts).toBe(1)
    expect(result.retryable).toBe(true)
  })

  it('retries a 5xx', async () => {
    const { result, clock } = await verifyOne(
      sequence(
        () => reply(503, {}, null),
        () => ok(),
      ),
    )

    expect(result.status).toBe('ok')
    expect(clock.sleeps).toEqual([2000])
  })

  it('reports a persistent 5xx as server-error', async () => {
    const { result } = await verifyOne(() => reply(502, {}, null))

    expect(result.status).toBe('server-error')
    expect(result.http_status).toBe(502)
    expect(result.retryable).toBe(true)
  })

  it('retries a network error and reports no HTTP status for it', async () => {
    const failing = await verifyOne(() => new Error('ECONNRESET'))
    const recovering = await verifyOne(
      sequence(
        () => new Error('ECONNRESET'),
        () => ok(),
      ),
    )

    expect(failing.result.status).toBe('network-error')
    expect(failing.result.http_status).toBeNull()
    expect(failing.result.retryable).toBe(true)
    expect(recovering.result.status).toBe('ok')
  })

  it('stops after the injected attempt count', async () => {
    const { result, clock } = await verifyOne(() => reply(404, {}, null), {
      maxAttempts: 2,
    })

    expect(result.attempts).toBe(2)
    expect(clock.sleeps).toEqual([2000])
  })

  it('follows an injected schedule', async () => {
    const { clock } = await verifyOne(
      sequence(
        () => reply(404, {}, null),
        () => reply(404, {}, null),
        () => reply(404, {}, null),
        () => ok(),
      ),
      { scheduleMs: [10, 20] },
    )

    expect(clock.sleeps).toEqual([10, 20, 20])
  })

  it('resumes the schedule where earlier calls left off', async () => {
    const { clock } = await verifyOne(
      sequence(
        () => reply(404, {}, null),
        () => ok(),
      ),
      { waitedMs: 29_000 },
    )

    expect(clock.sleeps).toEqual([30_000])
  })

  it('makes one attempt, not retryable, once the 300 s budget is spent', async () => {
    const { result, clock } = await verifyOne(() => reply(404, {}, null), {
      waitedMs: 295_000,
    })

    expect(clock.sleeps).toEqual([])
    expect(result.attempts).toBe(1)
    expect(result.retryable).toBe(false)
  })

  it('counts request time against the wait', async () => {
    const { clock, result } = await verifyOne(() => HANG, {
      requestTimeoutMs: 10_000,
    })

    expect(result.status).toBe('timeout')
    expect(clock.now()).toBeLessThanOrEqual(90_000)
  })

  it('cuts a request short at the time left in the call', async () => {
    // Attempt 1 hangs for 10 s, the wait takes 2 s, so 3 s of the 15 s remain
    // for attempt 2. It must give up then, not after its own 10 s.
    const { result, clock, calls } = await verifyOne(() => HANG, {
      maxWaitMs: 15_000,
      requestTimeoutMs: 10_000,
      scheduleMs: [2000],
    })

    expect(calls).toHaveLength(2)
    expect(result.attempts).toBe(2)
    expect(result.status).toBe('timeout')
    expect(clock.now()).toBe(15_000)
  })

  it('starts no attempt once the call budget is spent', async () => {
    // The wait ends exactly at the 12 s limit, so there is no time left to ask.
    const { result, clock, calls } = await verifyOne(() => HANG, {
      maxWaitMs: 12_000,
      requestTimeoutMs: 10_000,
      scheduleMs: [2000],
    })

    expect(calls).toHaveLength(1)
    expect(result.attempts).toBe(1)
    expect(result.status).toBe('timeout')
    expect(result.retryable).toBe(true)
    expect(clock.now()).toBe(12_000)
  })

  it('still makes its one attempt when earlier calls spent the whole budget', async () => {
    const { result, calls } = await verifyOne(() => reply(404, {}, null), {
      waitedMs: 300_000,
    })

    expect(calls).toHaveLength(1)
    expect(result.attempts).toBe(1)
    expect(result.status).toBe('not-found')
    expect(result.retryable).toBe(false)
  })

  it('cuts a request in a redirect chain short at the time left in the call', async () => {
    const next = embedUrl('moved.png', 'media.githubusercontent.com')
    const { result, clock } = await verifyOne(
      (url) => (url === A_PNG ? redirectTo(next) : HANG),
      { maxWaitMs: 4000, requestTimeoutMs: 10_000, scheduleMs: [1000] },
    )

    // Attempt 1 follows the redirect and hangs 4 s (the whole call limit).
    // Nothing may start after that.
    expect(result.status).toBe('timeout')
    expect(result.attempts).toBe(1)
    expect(clock.now()).toBe(4000)
  })
})

// ── Fail at once ───────────────────────────────────────────────────────────

describe('verify: failures that are not retried', () => {
  it('fails a 200 text/html at once', async () => {
    const { result, clock, calls } = await verifyOne(() =>
      reply(200, {}, 'text/html; charset=utf-8'),
    )

    expect(result).toEqual({
      url: A_PNG,
      status: 'not-an-image',
      http_status: 200,
      attempts: 1,
      retryable: false,
    })
    expect(clock.sleeps).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('fails a 200 with no content type', async () => {
    const { result } = await verifyOne(() => reply(200, {}, null))

    expect(result.status).toBe('not-an-image')
  })

  it('fails a 200 that only claims to be an image in its name', async () => {
    const { result } = await verifyOne(() =>
      reply(200, {}, 'application/octet-stream'),
    )

    expect(result.status).toBe('not-an-image')
  })

  it.each([
    ['image/png', 'ok', 0],
    ['application/x-image/png', 'not-an-image', 1],
    ['text/image/png', 'not-an-image', 1],
    ['multipart/image/png', 'not-an-image', 1],
  ] as const)(
    'reads %s as %s, so verify exits %d: the media type must start with image/',
    async (type, status, exitCode) => {
      const helper = await loadHelper()
      const clock = makeClock()
      const { fetchFn } = makeFetch(() => ok(type))

      const done = await clock.run(
        helper.runVerify({ urls: [A_PNG] }, optionsFor(clock, fetchFn)),
      )

      expect(done.body.results[0]?.status).toBe(status)
      expect(done.body.results[0]?.http_status).toBe(200)
      expect(done.exitCode).toBe(exitCode)
      expect(clock.sleeps).toEqual([])
    },
  )

  it.each([401, 403])('fails %d at once as forbidden', async (code) => {
    const { result, clock } = await verifyOne(() => reply(code, {}, null))

    expect(result.status).toBe('forbidden')
    expect(result.http_status).toBe(code)
    expect(result.attempts).toBe(1)
    expect(result.retryable).toBe(false)
    expect(clock.sleeps).toEqual([])
  })

  it.each([204, 206, 304, 400, 410])(
    'fails %d at once as an unexpected status',
    async (code) => {
      const { result, clock } = await verifyOne(() => reply(code, {}, null))

      expect(result.status).toBe('unexpected-status')
      expect(result.http_status).toBe(code)
      expect(result.retryable).toBe(false)
      expect(clock.sleeps).toEqual([])
    },
  )
})

// ── Redirects ──────────────────────────────────────────────────────────────

describe('verify: redirects', () => {
  const first = A_PNG
  const second = embedUrl('moved.png')

  it('passes a redirect that ends in an image', async () => {
    const { result, calls } = await verifyOne((url) =>
      url === first ? redirectTo(second) : ok(),
    )

    expect(result.status).toBe('ok')
    expect(result.attempts).toBe(1)
    expect(calls.map((call) => call.url)).toEqual([first, second])
  })

  it('sends the same bare request on every hop', async () => {
    const { calls } = await verifyOne((url) =>
      url === first ? redirectTo(second, 307) : ok(),
    )

    for (const call of calls) {
      expect(call.init.redirect).toBe('manual')
      expect(call.init.credentials).toBe('omit')
      expect(new Headers(call.init.headers).has('authorization')).toBe(false)
    }
  })

  it('resolves a relative Location against the current URL', async () => {
    const { result, calls } = await verifyOne((url) =>
      url === first
        ? redirectTo(`/octo/repo/${SHA}/docs/evidence/demo/rel.png`)
        : ok(),
    )

    expect(result.status).toBe('ok')
    expect(calls[1]?.url).toBe(embedUrl('rel.png'))
  })

  it('follows a redirect to media.githubusercontent.com', async () => {
    const media = 'https://media.githubusercontent.com/media/octo/repo/x.png'
    const { result } = await verifyOne((url) =>
      url === first ? redirectTo(media) : ok(),
    )

    expect(result.status).toBe('ok')
  })

  it.each([
    ['another host', 'https://example.com/a.png'],
    ['a look-alike host', 'https://raw.githubusercontent.com.evil.test/a.png'],
    ['github.com itself', 'https://github.com/octo/repo/raw/main/a.png'],
    ['plain http', `http://raw.githubusercontent.com/octo/repo/${SHA}/a.png`],
    [
      'a non-default port',
      `https://raw.githubusercontent.com:8443/octo/repo/${SHA}/a.png`,
    ],
    [
      'embedded credentials',
      `https://user:secret@raw.githubusercontent.com/octo/repo/${SHA}/a.png`,
    ],
    ['a data URL', 'data:image/png;base64,AAAA'],
  ])('fails a redirect to %s without requesting it', async (_name, target) => {
    const { result, calls, clock } = await verifyOne((url) =>
      url === first ? redirectTo(target) : ok(),
    )

    expect(result).toEqual({
      url: first,
      status: 'redirect-off-host',
      http_status: 302,
      attempts: 1,
      retryable: false,
    })
    expect(calls.map((call) => call.url)).toEqual([first])
    expect(clock.sleeps).toEqual([])
  })

  it('fails a redirect with no Location as bad-redirect', async () => {
    const { result } = await verifyOne(() => reply(302, {}, null))

    expect(result.status).toBe('bad-redirect')
    expect(result.retryable).toBe(false)
  })

  it('follows 5 redirects and fails the 6th', async () => {
    const chain = (hops: number) => (url: string) => {
      const index = url === A_PNG ? 0 : Number(url.match(/hop(\d+)\.png$/)?.[1])
      return index < hops ? redirectTo(embedUrl(`hop${index + 1}.png`)) : ok()
    }

    const five = await verifyOne(chain(5))
    const six = await verifyOne(chain(6))

    expect(five.result.status).toBe('ok')
    expect(five.calls).toHaveLength(6)
    expect(six.result.status).toBe('too-many-redirects')
    expect(six.result.retryable).toBe(false)
    expect(six.calls).toHaveLength(6)
    expect(six.clock.sleeps).toEqual([])
  })

  it('fails a redirect loop without retrying', async () => {
    const { result, calls, clock } = await verifyOne((url) =>
      redirectTo(url === A_PNG ? B_PNG : A_PNG),
    )

    expect(result.status).toBe('too-many-redirects')
    expect(result.attempts).toBe(1)
    expect(result.retryable).toBe(false)
    expect(calls).toHaveLength(6)
    expect(clock.sleeps).toEqual([])
  })
})

// ── Bounded reading ────────────────────────────────────────────────────────

describe('verify: response bodies', () => {
  it('cancels every body it is given and never reads one', async () => {
    const replies: Array<() => Step> = [
      () => ok(),
      () => reply(200, {}, 'text/html'),
      () => reply(404, {}, 'text/plain'),
      () => reply(403, {}, null),
      () => redirectTo(embedUrl('next.png')),
      () => ok(),
    ]
    await verifyOne(sequence(...replies), { maxAttempts: 1 })
    await verifyOne(() => reply(200, {}, 'text/html'))
    await verifyOne(() => reply(500, {}, null), { maxAttempts: 2 })
    await verifyOne(() => reply(403, {}, null))

    expect(probes.length).toBeGreaterThan(0)
    for (const probe of probes) {
      expect(probe.reads).toBe(0)
      expect(probe.cancels).toBeGreaterThanOrEqual(1)
    }
  })

  it('never puts a body or a header value in its report', async () => {
    const helper = await loadHelper()
    const clock = makeClock()
    const { fetchFn } = makeFetch(() =>
      reply(200, { 'x-secret': CANARY }, 'text/html'),
    )

    const { exitCode, body } = await clock.run(
      helper.runVerify({ urls: [A_PNG] }, optionsFor(clock, fetchFn)),
    )

    expect(exitCode).toBe(1)
    expect(JSON.stringify(body)).not.toContain(CANARY)
  })
})

// ── Timeouts ───────────────────────────────────────────────────────────────

describe('verify: per-request timeout', () => {
  it('times a stalled request out, aborts it and retries', async () => {
    const { result, clock, calls } = await verifyOne(
      sequence(
        () => HANG,
        () => ok(),
      ),
      { requestTimeoutMs: 10_000 },
    )

    expect(result.status).toBe('ok')
    expect(result.attempts).toBe(2)
    expect(calls[0]?.init.signal?.aborted).toBe(true)
    expect(clock.sleeps).toEqual([2000])
    expect(clock.now()).toBe(12_000)
  })

  it('reports a request that always stalls as a retryable timeout', async () => {
    const { result, calls } = await verifyOne(() => HANG, {
      requestTimeoutMs: 10_000,
    })

    expect(result).toEqual({
      url: A_PNG,
      status: 'timeout',
      http_status: null,
      attempts: 5,
      retryable: true,
    })
    expect(calls.every((call) => call.init.signal?.aborted)).toBe(true)
  })

  it('does not time out a request that finishes in time', async () => {
    const { calls } = await verifyOne(() => ok(), { requestTimeoutMs: 10_000 })

    expect(calls[0]?.init.signal?.aborted).toBeFalsy()
  })
})

// ── Several URLs ───────────────────────────────────────────────────────────

describe('verify: several URLs', () => {
  it('checks them together, names the failures, and takes the longest time', async () => {
    const { results, clock, waitedMs } = await verify(
      [A_PNG, B_PNG, C_PNG],
      (url) => (url === A_PNG ? ok() : reply(404, {}, 'text/plain')),
    )

    expect(results.map((entry) => [entry.url, entry.status])).toEqual([
      [A_PNG, 'ok'],
      [B_PNG, 'not-found'],
      [C_PNG, 'not-found'],
    ])
    // Each failing URL gets the full schedule: 7 attempts, not one after
    // the other.
    expect(results.map((entry) => entry.attempts)).toEqual([1, 7, 7])
    expect(waitedMs).toBe(89_000)
    expect(clock.now()).toBe(89_000)
  })

  it('does not hold a fast URL back for a slow one', async () => {
    const { results } = await verify([A_PNG, B_PNG], (url, nth) =>
      url === A_PNG || nth > 0 ? ok() : reply(404, {}, null),
    )

    expect(results.find((entry) => entry.url === A_PNG)?.attempts).toBe(1)
    expect(results.find((entry) => entry.url === B_PNG)?.attempts).toBe(2)
  })
})

// ── The subcommand: report shape and exit codes ────────────────────────────

describe('verify: report and exit codes', () => {
  async function runVerify(raw: unknown, handler: () => Step = () => ok()) {
    const helper = await loadHelper()
    const clock = makeClock()
    const { fetchFn, calls } = makeFetch(handler)
    const done = await clock.run(
      helper.runVerify(raw, optionsFor(clock, fetchFn)),
    )
    return { ...done, calls }
  }

  it('exits 0 and says verified when every URL passes', async () => {
    const { exitCode, body } = await runVerify({ urls: [A_PNG, B_PNG] })

    expect(exitCode).toBe(0)
    expect(body).toMatchObject({
      schema_version: 1,
      operation: 'verify',
      result: 'verified',
      checked: 2,
      passed: 2,
      retryable: false,
      waited_s: 0,
      failed: [],
    })
    expect(body.results.map((entry) => entry.status)).toEqual(['ok', 'ok'])
  })

  it('exits 1, names each failing URL with its reason, and flags what can be retried', async () => {
    const helper = await loadHelper()
    const clock = makeClock()
    const { fetchFn } = makeFetch((url) => {
      if (url === A_PNG) {
        return ok()
      }
      return url === B_PNG ? reply(200, {}, 'text/html') : reply(404, {}, null)
    })

    const { exitCode, body } = await clock.run(
      helper.runVerify(
        { urls: [A_PNG, B_PNG, C_PNG] },
        optionsFor(clock, fetchFn),
      ),
    )

    expect(exitCode).toBe(1)
    expect(body.result).toBe('failed')
    expect(body.checked).toBe(3)
    expect(body.passed).toBe(1)
    expect(body.failed.map((entry) => [entry.url, entry.status])).toEqual([
      [B_PNG, 'not-an-image'],
      [C_PNG, 'not-found'],
    ])
    expect(body.retryable).toBe(true)
    expect(body.waited_s).toBe(89)
  })

  it('is not retryable when the only failure is an HTML 200', async () => {
    const { exitCode, body } = await runVerify({ urls: [A_PNG] }, () =>
      reply(200, {}, 'text/html'),
    )

    expect(exitCode).toBe(1)
    expect(body.retryable).toBe(false)
  })

  it('reports waited_s as the waited_s it was given plus this call', async () => {
    // Resuming at 20 s, the next wait is 15 s. A 40 s call limit fits one wait
    // of 15 s and stops before the next one of 30 s.
    const { body } = await runVerify(
      { urls: [A_PNG], max_wait_s: 40, waited_s: 20 },
      () => reply(404, {}, null),
    )

    expect(body.waited_s).toBe(35)
  })

  it('lets the caller pass the latest waited_s on unchanged', async () => {
    const first = await runVerify(
      { urls: [A_PNG], max_wait_s: 40, waited_s: 0 },
      () => reply(404, {}, null),
    )
    const second = await runVerify(
      { urls: [A_PNG], max_wait_s: 40, waited_s: first.body.waited_s },
      () => reply(404, {}, null),
    )

    expect(first.body.retryable).toBe(true)
    expect(second.body.waited_s).toBeGreaterThan(first.body.waited_s)
    // The second report already counts the first, so nothing is summed by hand.
    expect(second.body.waited_s).toBeGreaterThanOrEqual(
      first.body.waited_s + 14,
    )
  })

  it('ends retries once the reported waited_s reaches the 300 s total', async () => {
    const { body } = await runVerify({ urls: [A_PNG], waited_s: 295 }, () =>
      reply(404, {}, null),
    )

    expect(body.waited_s).toBe(295)
    expect(body.retryable).toBe(false)
  })

  it('takes max_wait_s, waited_s and request_timeout_s from the input', async () => {
    const { body, exitCode } = await runVerify(
      { urls: [A_PNG], max_wait_s: 10, waited_s: 0, request_timeout_s: 5 },
      () => reply(404, {}, null),
    )

    expect(exitCode).toBe(1)
    expect(body.waited_s).toBe(6)
    expect(body.results[0]?.attempts).toBe(3)
  })

  it('accepts head_repo and checks the URLs against it', async () => {
    const accepted = await runVerify({ urls: [A_PNG], head_repo: 'Octo/Repo' })
    const refused = await runVerify({ urls: [A_PNG], head_repo: 'octo/other' })

    expect(accepted.exitCode).toBe(0)
    expect(refused.exitCode).toBe(2)
    expect(refused.body.error).toBe('invalid-url')
    expect(refused.calls).toHaveLength(0)
  })
})

describe('verify: usage errors', () => {
  async function usage(raw: unknown) {
    const helper = await loadHelper()
    const { fetchFn, calls } = makeFetch(() => ok())
    const done = await helper.runVerify(raw, { fetch: fetchFn })
    return { ...done, calls }
  }

  it.each([
    ['an empty URL list', { urls: [] }, 'empty-urls'],
    ['no urls field', {}, 'invalid-input'],
    ['urls that is not an array', { urls: A_PNG }, 'invalid-input'],
    ['input that is not an object', [A_PNG], 'invalid-input'],
    ['a URL that is not a string', { urls: [7] }, 'invalid-url'],
    ['an empty string URL', { urls: [''] }, 'invalid-url'],
    [
      'a blob URL',
      {
        urls: [
          `https://github.com/octo/repo/blob/${SHA}/docs/evidence/demo/a.png?raw=true`,
        ],
      },
      'blob-url',
    ],
    [
      'a blob URL without ?raw=true',
      {
        urls: [
          `https://github.com/octo/repo/blob/${SHA}/docs/evidence/demo/a.png`,
        ],
      },
      'blob-url',
    ],
    [
      'plain http',
      {
        urls: [
          `http://raw.githubusercontent.com/octo/repo/${SHA}/docs/evidence/demo/a.png`,
        ],
      },
      'invalid-url',
    ],
    [
      'another host',
      {
        urls: [`https://example.com/octo/repo/${SHA}/docs/evidence/demo/a.png`],
      },
      'invalid-url',
    ],
    [
      'media.githubusercontent.com as the first URL',
      { urls: [embedUrl('a.png', 'media.githubusercontent.com')] },
      'invalid-url',
    ],
    [
      'a raw URL outside docs/evidence',
      {
        urls: [`https://raw.githubusercontent.com/octo/repo/${SHA}/README.md`],
      },
      'invalid-url',
    ],
    [
      'a branch name instead of a commit',
      {
        urls: [
          'https://raw.githubusercontent.com/octo/repo/main/docs/evidence/demo/a.png',
        ],
      },
      'invalid-url',
    ],
    ['a query string', { urls: [`${A_PNG}?token=1`] }, 'invalid-url'],
    ['a fragment', { urls: [`${A_PNG}#frag`] }, 'invalid-url'],
    [
      'one bad URL among good ones',
      { urls: [A_PNG, 'https://example.com/x.png'] },
      'invalid-url',
    ],
    [
      'more URLs than the limit',
      {
        urls: Array.from({ length: 51 }, (_, index) =>
          embedUrl(`i${index}.png`),
        ),
      },
      'too-many-urls',
    ],
    ['max_wait_s of zero', { urls: [A_PNG], max_wait_s: 0 }, 'invalid-input'],
    [
      'a negative max_wait_s',
      { urls: [A_PNG], max_wait_s: -1 },
      'invalid-input',
    ],
    [
      'a string max_wait_s',
      { urls: [A_PNG], max_wait_s: '90' },
      'invalid-input',
    ],
    [
      'max_wait_s over 300',
      { urls: [A_PNG], max_wait_s: 301 },
      'invalid-input',
    ],
    ['a negative waited_s', { urls: [A_PNG], waited_s: -1 }, 'invalid-input'],
    ['a NaN-like waited_s', { urls: [A_PNG], waited_s: null }, 'invalid-input'],
    [
      'request_timeout_s of zero',
      { urls: [A_PNG], request_timeout_s: 0 },
      'invalid-input',
    ],
    [
      'a malformed head_repo',
      { urls: [A_PNG], head_repo: 'octo' },
      'invalid-input',
    ],
  ])('exits 2 for %s and makes no request', async (_name, raw, error) => {
    const { exitCode, body, calls } = await usage(raw)

    expect(exitCode).toBe(2)
    expect(body.result).toBe('usage-error')
    expect(body.error).toBe(error)
    expect(calls).toHaveLength(0)
  })

  it('never echoes the rejected input', async () => {
    const { body } = await usage({
      urls: [`https://example.com/${CANARY}.png`],
    })

    expect(JSON.stringify(body)).not.toContain(CANARY)
  })
})

describe('verify: command line', () => {
  function cli(input: unknown) {
    const result = spawnSync('node', [SCRIPT_PATH, 'verify'], {
      input: JSON.stringify(input),
      encoding: 'utf8',
    })
    return {
      status: result.status,
      stderr: result.stderr,
      report: JSON.parse(result.stdout) as VerifyReport,
    }
  }

  it('exits 2 on an empty URL list', () => {
    const { status, report, stderr } = cli({ urls: [] })

    expect(status).toBe(2)
    expect(report).toMatchObject({
      operation: 'verify',
      result: 'usage-error',
      error: 'empty-urls',
    })
    expect(stderr).toBe('')
  })

  it('exits 2 on a blob URL without any network access', () => {
    const { status, report } = cli({
      urls: [
        `https://github.com/octo/repo/blob/${SHA}/docs/evidence/demo/a.png?raw=true`,
      ],
    })

    expect(status).toBe(2)
    expect(report.error).toBe('blob-url')
  })

  it('names verify in the usage line', () => {
    const { report } = cli({ urls: [] })

    expect(report.usage).toContain('verify')
  })
})

// ── The same code against a real HTTP server, under real node ──────────────

interface Stub {
  readonly origin: string
  readonly hits: Map<string, number>
  readonly close: () => Promise<void>
}

const stubs: Stub[] = []

async function startServer(
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    hit: number,
  ) => void,
): Promise<Stub> {
  const hits = new Map<string, number>()
  const server = http.createServer((request, response) => {
    const key = request.url ?? ''
    const hit = (hits.get(key) ?? 0) + 1
    hits.set(key, hit)
    handler(request, response, hit)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  const stub: Stub = {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  stubs.push(stub)
  return stub
}

afterEach(async () => {
  while (stubs.length > 0) {
    await stubs.pop()?.close()
  }
})

// Runs `verifyUrls` in a real node process. Backoff sleeps are recorded and
// skipped (virtual time), so the only thing that is real is the socket.
const NODE_HARNESS = `
const helper = await import(process.env.HELPER_URL)
const config = JSON.parse(process.env.CASE)
let virtual = 0
const sleeps = []
const done = await helper.verifyUrls(config.urls, {
  sleep: async (ms) => { sleeps.push(ms); virtual += ms },
  now: () => virtual + performance.now(),
  random: () => 0.5,
  isAllowedTarget: (target) => target.origin === config.origin,
  requestTimeoutMs: config.requestTimeoutMs ?? 5000,
})
process.stdout.write(JSON.stringify({ ...done, sleeps }))
`

interface NodeRun {
  readonly results: UrlResult[]
  readonly sleeps: number[]
  readonly stdout: string
}

function runInNode(config: {
  urls: string[]
  origin: string
  requestTimeoutMs?: number
}): Promise<NodeRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--input-type=module', '-e', NODE_HARNESS], {
      env: {
        PATH: process.env.PATH ?? '',
        HELPER_URL: pathToFileURL(SCRIPT_PATH).href,
        CASE: JSON.stringify(config),
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`harness exited ${code}: ${stderr}`))
        return
      }
      resolve({ ...(JSON.parse(stdout) as NodeRun), stdout })
    })
  })
}

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function sendImage(response: http.ServerResponse) {
  response.writeHead(200, { 'content-type': 'image/png' })
  response.end(PNG_HEAD)
}

describe('verify: real HTTP server under node', () => {
  it('passes a 200 image/png', async () => {
    const server = await startServer((_request, response) =>
      sendImage(response),
    )

    const run = await runInNode({
      urls: [`${server.origin}/a.png`],
      origin: server.origin,
    })

    expect(run.results[0]).toMatchObject({
      status: 'ok',
      http_status: 200,
      attempts: 1,
    })
    expect(server.hits.get('/a.png')).toBe(1)
  })

  it('passes a 404 that becomes a 200 on the schedule', async () => {
    const server = await startServer((_request, response, hit) => {
      if (hit < 3) {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end(CANARY)
        return
      }
      sendImage(response)
    })

    const run = await runInNode({
      urls: [`${server.origin}/a.png`],
      origin: server.origin,
    })

    expect(run.results[0]?.status).toBe('ok')
    expect(run.results[0]?.attempts).toBe(3)
    expect(run.sleeps).toEqual([2000, 4000])
    expect(run.stdout).not.toContain(CANARY)
  })

  it('fails a 200 text/html and does not echo the page', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<html>${CANARY}</html>`)
    })

    const run = await runInNode({
      urls: [`${server.origin}/a.png`],
      origin: server.origin,
    })

    expect(run.results[0]).toMatchObject({
      status: 'not-an-image',
      attempts: 1,
      retryable: false,
    })
    expect(server.hits.get('/a.png')).toBe(1)
    expect(run.stdout).not.toContain(CANARY)
  })

  it('follows a redirect chain that ends in an image', async () => {
    const server = await startServer((request, response) => {
      if (request.url === '/a.png') {
        response.writeHead(302, { location: '/b.png' })
        response.end()
        return
      }
      if (request.url === '/b.png') {
        response.writeHead(301, { location: `${server.origin}/c.png` })
        response.end()
        return
      }
      sendImage(response)
    })

    const run = await runInNode({
      urls: [`${server.origin}/a.png`],
      origin: server.origin,
    })

    expect(run.results[0]?.status).toBe('ok')
    expect(server.hits.get('/c.png')).toBe(1)
  })

  it('does not request a redirect target on another origin', async () => {
    const elsewhere = await startServer((_request, response) =>
      sendImage(response),
    )
    const server = await startServer((_request, response) => {
      response.writeHead(302, { location: `${elsewhere.origin}/a.png` })
      response.end()
    })

    const run = await runInNode({
      urls: [`${server.origin}/a.png`],
      origin: server.origin,
    })

    expect(run.results[0]?.status).toBe('redirect-off-host')
    expect(elsewhere.hits.size).toBe(0)
  })

  it('stops a redirect loop after 6 requests', async () => {
    const server = await startServer((request, response) => {
      response.writeHead(302, {
        location: request.url === '/a.png' ? '/b.png' : '/a.png',
      })
      response.end()
    })

    const run = await runInNode({
      urls: [`${server.origin}/a.png`],
      origin: server.origin,
    })

    expect(run.results[0]?.status).toBe('too-many-redirects')
    const total = [...server.hits.values()].reduce((sum, hit) => sum + hit, 0)
    expect(total).toBe(6)
  })

  it('times out a server that never answers and drops the connection', async () => {
    let closed: () => void = () => undefined
    const dropped = new Promise<void>((resolve) => {
      closed = resolve
    })
    const server = await startServer((request) => {
      request.socket.on('close', closed)
    })

    const run = await runInNode({
      urls: [`${server.origin}/a.png`],
      origin: server.origin,
      requestTimeoutMs: 100,
    })
    await dropped

    expect(run.results[0]?.status).toBe('timeout')
    expect(run.results[0]?.retryable).toBe(true)
  })

  it('stops reading an endless image body after the headers', async () => {
    let written = 0
    let closed: () => void = () => undefined
    const dropped = new Promise<void>((resolve) => {
      closed = resolve
    })
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' })
      const chunk = Buffer.alloc(64 * 1024, 0x41)
      const pump = () => {
        while (!response.destroyed && response.write(chunk)) {
          written += chunk.length
        }
        if (!response.destroyed) {
          response.once('drain', pump)
        }
      }
      response.on('close', closed)
      pump()
    })

    const run = await runInNode({
      urls: [`${server.origin}/a.png`],
      origin: server.origin,
    })
    await dropped

    expect(run.results[0]?.status).toBe('ok')
    expect(written).toBeLessThan(64 * 1024 * 1024)
  })
})
