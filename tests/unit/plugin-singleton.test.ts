import { beforeEach, describe, expect, it } from 'bun:test'
import {
  _resetPluginSingleton,
  plugInOnce,
} from '../../src/lib/plugin-singleton.js'

describe('plugInOnce', () => {
  beforeEach(() => {
    _resetPluginSingleton()
  })

  it('runs doInit once and returns its result with isFirst=true on first invocation', async () => {
    let calls = 0
    const doInit = async () => {
      calls += 1
      return { tool: 'one' }
    }
    const result = await plugInOnce({ doInit, pid: 1 })
    expect(result.isFirst).toBe(true)
    expect(result.hooks).toEqual({ tool: 'one' })
    expect(calls).toBe(1)
  })

  it('returns empty hooks (isFirst=false) on subsequent calls in the same PID and never re-runs doInit', async () => {
    let calls = 0
    const realHooks = { tool: 'cached' }
    const doInit = async () => {
      calls += 1
      return realHooks
    }
    const r1 = await plugInOnce({ doInit, pid: 1 })
    const r2 = await plugInOnce({ doInit, pid: 1 })
    const r3 = await plugInOnce({ doInit, pid: 1 })
    // First invocation gets the real hooks reference.
    expect(r1.isFirst).toBe(true)
    expect(r1.hooks).toBe(realHooks)
    // Duplicates get an empty hooks envelope so the host registers nothing.
    expect(r2.isFirst).toBe(false)
    expect(r2.hooks).toEqual({})
    expect(r2.hooks).not.toBe(realHooks)
    expect(r3.isFirst).toBe(false)
    expect(r3.hooks).toEqual({})
    // doInit only ever ran once.
    expect(calls).toBe(1)
  })

  it('reruns init on a different pid without manual reset', async () => {
    // Exercises the singleton's PID-mismatch branch directly: populate
    // state with pid=1, then call again with pid=2 WITHOUT calling
    // `_resetPluginSingleton()`. Init must run fresh because the cached
    // pid does not match. This is the production code path for any
    // (extremely unlikely) cross-process state leak — the test confirms
    // the guard fires without test-only plumbing.
    let calls = 0
    const doInit = async () => {
      calls += 1
      return { call: calls }
    }
    const r1 = await plugInOnce({ doInit, pid: 1 })
    const r2 = await plugInOnce({ doInit, pid: 2 })
    expect(r1.isFirst).toBe(true)
    expect(r1.hooks.call).toBe(1)
    expect(r2.isFirst).toBe(true)
    expect(r2.hooks.call).toBe(2)
    expect(calls).toBe(2)
  })

  it('fires onDuplicate exactly once on first duplicate invocation', async () => {
    let duplicateCalls = 0
    const doInit = async () => ({})
    const onDuplicate = () => {
      duplicateCalls += 1
    }
    await plugInOnce({ doInit, onDuplicate, pid: 1 })
    await plugInOnce({ doInit, onDuplicate, pid: 1 })
    await plugInOnce({ doInit, onDuplicate, pid: 1 })
    await plugInOnce({ doInit, onDuplicate, pid: 1 })
    expect(duplicateCalls).toBe(1)
  })

  it('does not fire onDuplicate on the first invocation', async () => {
    let duplicateCalls = 0
    await plugInOnce({
      doInit: async () => ({}),
      onDuplicate: () => {
        duplicateCalls += 1
      },
      pid: 1,
    })
    expect(duplicateCalls).toBe(0)
  })

  it('passes the resolved pid to onDuplicate (test override flows through)', async () => {
    // The `pid` parameter makes the singleton testable in a single-process
    // Bun run by simulating different OS PIDs. The duplicate warning
    // emitted by callers includes the PID for diagnostics, so the value
    // passed to `onDuplicate` must match the one the guard used — not the
    // live `process.pid` — so test overrides surface faithfully.
    let receivedPid: number | undefined
    const onDuplicate = (pid: number) => {
      receivedPid = pid
    }
    await plugInOnce({ doInit: async () => ({}), onDuplicate, pid: 9001 })
    await plugInOnce({ doInit: async () => ({}), onDuplicate, pid: 9001 })
    expect(receivedPid).toBe(9001)
  })

  it('caches a rejected doInit promise and propagates the same rejection to duplicate callers', async () => {
    // Documents the sticky-rejection limitation: when `doInit()` rejects,
    // the rejected promise is cached. The first caller sees the rejection.
    // Duplicate callers ALSO see the same rejection (because the helper
    // awaits the cached promise before returning empty hooks) so failures
    // are not silently masked. Recovery requires a process restart.
    const error = new Error('init failed')
    let calls = 0
    const doInit = async () => {
      calls += 1
      throw error
    }
    await expect(plugInOnce({ doInit, pid: 1 })).rejects.toBe(error)
    await expect(plugInOnce({ doInit, pid: 1 })).rejects.toBe(error)
    await expect(plugInOnce({ doInit, pid: 1 })).rejects.toBe(error)
    expect(calls).toBe(1)
  })

  it('converges concurrent invocations on a single doInit run', async () => {
    let started = 0
    const doInit = async () => {
      started += 1
      // The 20ms delay is intentionally larger than the time it takes for
      // `Promise.all([...])` to issue all three `plugInOnce` calls. The
      // second and third calls observe the in-flight promise already
      // cached on `globalThis` and skip running `doInit`. Bun's microtask
      // scheduler resolves the synchronous portion of all three calls
      // before the 20ms timer fires; if a future Bun release introduces
      // microtask preemption between awaits, this test would need to
      // pivot to an explicit deferred-resolve fixture.
      await new Promise((r) => setTimeout(r, 20))
      return { tool: 'concurrent' }
    }
    const [r1, r2, r3] = await Promise.all([
      plugInOnce({ doInit, pid: 1 }),
      plugInOnce({ doInit, pid: 1 }),
      plugInOnce({ doInit, pid: 1 }),
    ])
    // Exactly one invocation gets isFirst=true; the others get empty hooks.
    const firsts = [r1, r2, r3].filter((r) => r.isFirst)
    const duplicates = [r1, r2, r3].filter((r) => !r.isFirst)
    expect(firsts.length).toBe(1)
    expect(duplicates.length).toBe(2)
    const firstResult = firsts[0]
    if (!firstResult) throw new Error('expected exactly one isFirst result')
    expect(firstResult.hooks).toEqual({ tool: 'concurrent' })
    for (const dup of duplicates) {
      expect(dup.hooks).toEqual({})
    }
    expect(started).toBe(1)
  })

  it('swallows onDuplicate exceptions and still returns empty hooks', async () => {
    let initCalls = 0
    let duplicateCalls = 0
    const doInit = async () => {
      initCalls += 1
      return { ok: true }
    }
    const onDuplicate = () => {
      duplicateCalls += 1
      throw new Error('boom')
    }
    await plugInOnce({ doInit, onDuplicate, pid: 1 })
    // The throwing onDuplicate must not propagate to plugin init.
    const result = await plugInOnce({ doInit, onDuplicate, pid: 1 })
    expect(result.isFirst).toBe(false)
    expect(result.hooks).toEqual({})
    expect(duplicateCalls).toBe(1)
    expect(initCalls).toBe(1)
  })

  it('does not fire onDuplicate again after the first time, even if onDuplicate threw', async () => {
    let duplicateCalls = 0
    const onDuplicate = () => {
      duplicateCalls += 1
      throw new Error('boom')
    }
    await plugInOnce({ doInit: async () => ({}), onDuplicate, pid: 1 })
    await plugInOnce({ doInit: async () => ({}), onDuplicate, pid: 1 })
    await plugInOnce({ doInit: async () => ({}), onDuplicate, pid: 1 })
    expect(duplicateCalls).toBe(1)
  })
})
