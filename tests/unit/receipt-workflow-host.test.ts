import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertMixedVersionProbeEvents,
  buildDetachedChildSpawnOptions,
  extractSkillNameFromPrompt,
  type ProbeEvent,
  scriptedResponseChunks,
  spawnOpencodeChild,
  startScriptedSkillModelServer,
  withScriptedProvider,
} from '../integration/fixtures/receipt-workflow-host.js'

// Absolute file:// URL to the real fixture source, resolved from THIS file
// so the isolated child process spawned below (its own fresh module graph,
// its own empty `process.listeners('SIGINT')`) can `import()` the exact
// same module under test.
const FIXTURE_MODULE_URL = pathToFileURL(
  path.join(
    import.meta.dirname,
    '../integration/fixtures/receipt-workflow-host.ts',
  ),
).href

const WORKFLOW_OPEN = '<SYSTEMATIC_WORKFLOWS>'
const WORKFLOW_CLOSE = '</SYSTEMATIC_WORKFLOWS>'
const SKILL_GUIDANCE =
  'Use `systematic_skill` to load Systematic bundled skills'

function chatEvents(system: readonly string[]): ProbeEvent[] {
  return [
    { type: 'loaded' },
    {
      type: 'system',
      kind: 'chat',
      input: { sessionID: 'test-session', model: {} },
      system: [...system],
    },
  ]
}

describe('receipt workflow host assertions', () => {
  test('accepts one closed workflow block with skill discovery guidance', () => {
    expect(() =>
      assertMixedVersionProbeEvents(
        chatEvents([`${WORKFLOW_OPEN}\n${SKILL_GUIDANCE}\n${WORKFLOW_CLOSE}`]),
      ),
    ).not.toThrow()
  })

  test('rejects an extra closing marker anywhere in the system entries', () => {
    expect(() =>
      assertMixedVersionProbeEvents(
        chatEvents([
          `${WORKFLOW_OPEN}\n${SKILL_GUIDANCE}\n${WORKFLOW_CLOSE}`,
          WORKFLOW_CLOSE,
        ]),
      ),
    ).toThrow()
  })

  test('rejects a workflow block without systematic_skill guidance', () => {
    expect(() =>
      assertMixedVersionProbeEvents(
        chatEvents([`${WORKFLOW_OPEN}\n${WORKFLOW_CLOSE}`]),
      ),
    ).toThrow()
  })
})

describe('extractSkillNameFromPrompt', () => {
  test('extracts the name from the fixed load-skill prompt shape', () => {
    expect(
      extractSkillNameFromPrompt(
        'Use the systematic_skill tool to load systematic:git-clean-gone-branches',
      ),
    ).toBe('systematic:git-clean-gone-branches')
    expect(
      extractSkillNameFromPrompt(
        'Use the systematic_skill tool to load ce:review',
      ),
    ).toBe('ce:review')
  })

  test('throws on a prompt that does not match the fixed shape', () => {
    expect(() =>
      extractSkillNameFromPrompt('Please load git-clean-gone-branches'),
    ).toThrow(/could not extract a skill name/)
    expect(() =>
      extractSkillNameFromPrompt(
        'Use the systematic_skill tool to load two words',
      ),
    ).toThrow(/could not extract a skill name/)
  })
})

describe('withScriptedProvider', () => {
  test("preserves the caller's existing config fields and produces parseable JSON", () => {
    const merged = withScriptedProvider(
      JSON.stringify({ plugin: ['file:///a.js', 'file:///b.js'] }),
      'http://localhost:1234/v1',
    )
    const parsed = JSON.parse(merged) as {
      plugin: string[]
      provider: Record<string, unknown>
    }
    expect(parsed.plugin).toEqual(['file:///a.js', 'file:///b.js'])
    expect(Object.keys(parsed.provider)).toContain(
      'systematic-host-contract-provider',
    )
  })

  test('merges into an existing provider key rather than clobbering it', () => {
    const merged = withScriptedProvider(
      JSON.stringify({
        plugin: ['file:///a.js'],
        provider: { 'existing-provider': { id: 'existing-provider' } },
      }),
      'http://localhost:1234/v1',
    )
    const parsed = JSON.parse(merged) as { provider: Record<string, unknown> }
    expect(Object.keys(parsed.provider).sort()).toEqual(
      ['existing-provider', 'systematic-host-contract-provider'].sort(),
    )
    expect(parsed.provider['existing-provider']).toEqual({
      id: 'existing-provider',
    })
  })
})

describe('scriptedResponseChunks', () => {
  test('shapes a tool-call response as a tool_calls delta then a tool_calls finish', () => {
    const chunks = scriptedResponseChunks(
      {
        toolCalls: [
          { id: 'call-1', name: 'systematic_skill', arguments: { name: 'x' } },
        ],
      },
      'req-1',
      1_000,
    )
    expect(chunks).toHaveLength(2)
    const first = chunks[0] as {
      choices: [{ delta: { tool_calls: unknown[] }; finish_reason: null }]
    }
    expect(first.choices[0].delta.tool_calls).toHaveLength(1)
    expect(first.choices[0].finish_reason).toBeNull()
    const last = chunks.at(-1) as { choices: [{ finish_reason: string }] }
    expect(last.choices[0].finish_reason).toBe('tool_calls')
  })

  test('shapes a text response as an assistant-role delta, a content delta, then stop', () => {
    const chunks = scriptedResponseChunks({ text: 'hello' }, 'req-2', 1_000)
    expect(chunks).toHaveLength(3)
    const roleChunk = chunks[0] as { choices: [{ delta: { role?: string } }] }
    expect(roleChunk.choices[0].delta.role).toBe('assistant')
    const contentChunk = chunks[1] as {
      choices: [{ delta: { content?: string } }]
    }
    expect(contentChunk.choices[0].delta.content).toBe('hello')
    const stopChunk = chunks.at(-1) as { choices: [{ finish_reason: string }] }
    expect(stopChunk.choices[0].finish_reason).toBe('stop')
  })

  test('shapes an empty-text response as an empty delta then stop, with no content chunk', () => {
    const chunks = scriptedResponseChunks({}, 'req-3', 1_000)
    expect(chunks).toHaveLength(2)
    const firstChunk = chunks[0] as {
      choices: [{ delta: Record<string, unknown> }]
    }
    expect(firstChunk.choices[0].delta).toEqual({})
    const stopChunk = chunks.at(-1) as { choices: [{ finish_reason: string }] }
    expect(stopChunk.choices[0].finish_reason).toBe('stop')
  })
})

interface ScriptedChunk {
  choices: [
    {
      delta: {
        role?: string
        content?: string
        tool_calls?: unknown[]
      }
      finish_reason: string | null
    },
  ]
}

async function postChatCompletion(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<ScriptedChunk[]> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice('data: '.length)) as ScriptedChunk)
}

describe('startScriptedSkillModelServer dispatch', () => {
  test('an empty-tools request (the title-generation turn) gets plain text, never a tool call', async () => {
    const model = startScriptedSkillModelServer('demo-skill', 'done text')
    try {
      const chunks = await postChatCompletion(model.url, {
        tools: {},
        messages: [{ role: 'user', content: 'Generate a title' }],
      })
      expect(chunks.some((chunk) => chunk.choices[0].delta.tool_calls)).toBe(
        false,
      )
      expect(
        chunks.some((chunk) => chunk.choices[0].delta.role === 'assistant'),
      ).toBe(true)
    } finally {
      model.stop()
    }
  })

  test('a tools-present request with no prior tool message gets the scripted systematic_skill call', async () => {
    const model = startScriptedSkillModelServer('demo-skill', 'done text')
    try {
      const chunks = await postChatCompletion(model.url, {
        tools: [{ type: 'function', function: { name: 'systematic_skill' } }],
        messages: [{ role: 'user', content: 'load demo-skill' }],
      })
      const toolCallChunk = chunks.find(
        (chunk) => chunk.choices[0].delta.tool_calls,
      )
      expect(toolCallChunk).toBeDefined()
      const toolCalls = toolCallChunk?.choices[0].delta.tool_calls as Array<{
        function: { name: string; arguments: string }
      }>
      expect(toolCalls[0]?.function.name).toBe('systematic_skill')
      expect(JSON.parse(toolCalls[0]?.function.arguments ?? '{}')).toEqual({
        name: 'demo-skill',
      })
    } finally {
      model.stop()
    }
  })

  test('a tools-present request with a prior tool-role message gets the completion text', async () => {
    const model = startScriptedSkillModelServer('demo-skill', 'done text')
    try {
      const chunks = await postChatCompletion(model.url, {
        tools: [{ type: 'function', function: { name: 'systematic_skill' } }],
        messages: [
          { role: 'user', content: 'load demo-skill' },
          { role: 'tool', content: 'skill loaded' },
        ],
      })
      expect(chunks.some((chunk) => chunk.choices[0].delta.tool_calls)).toBe(
        false,
      )
      const contentChunk = chunks.find(
        (chunk) => chunk.choices[0].delta.content !== undefined,
      )
      expect(contentChunk?.choices[0].delta.content).toBe('done text')
    } finally {
      model.stop()
    }
  })

  test('caps the scripted tool call to once per server instance: a second tools-present request without a tool message still gets the completion text', async () => {
    const model = startScriptedSkillModelServer('demo-skill', 'done text')
    try {
      const first = await postChatCompletion(model.url, {
        tools: [{ type: 'function', function: { name: 'systematic_skill' } }],
        messages: [{ role: 'user', content: 'load demo-skill' }],
      })
      expect(first.some((chunk) => chunk.choices[0].delta.tool_calls)).toBe(
        true,
      )

      const second = await postChatCompletion(model.url, {
        tools: [{ type: 'function', function: { name: 'systematic_skill' } }],
        messages: [{ role: 'user', content: 'load demo-skill again' }],
      })
      expect(second.some((chunk) => chunk.choices[0].delta.tool_calls)).toBe(
        false,
      )
      const contentChunk = second.find(
        (chunk) => chunk.choices[0].delta.content !== undefined,
      )
      expect(contentChunk?.choices[0].delta.content).toBe('done text')
    } finally {
      model.stop()
    }
  })
})

const TEST_CHILD_ENV = { PATH: process.env.PATH ?? '' }

// Regression test for the Bun.serve + synchronous-spawn deadlock:
// `runOpencode` previously blocked its own thread with a synchronous spawn
// while the scripted model server (also on that thread) needed to answer
// the spawned child's HTTP request — every call hung to TIMEOUT_MS. This
// drives the server through `spawnOpencodeChild` itself — the exact
// production helper `runOpencode` calls — rather than a hand-rolled spawn,
// so reverting that helper to a synchronous spawn would fail this test. It
// needs no `opencode` or `bunx` on `PATH` — the spawned child only performs
// a `fetch` against the scripted server, exactly like `runOpencode`'s CLI
// child does once it reaches the model.
describe('scripted server survives an async-spawned child (deadlock regression)', () => {
  test('spawnOpencodeChild can fetch a real response from the scripted server while the test thread stays live', async () => {
    const model = startScriptedSkillModelServer('demo-skill', 'done text')
    try {
      const script = `
        const response = await fetch(${JSON.stringify(`${model.url}/chat/completions`)}, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tools: [{ type: 'function' }], messages: [] }),
        })
        process.stdout.write(await response.text())
      `
      const result = await spawnOpencodeChild(['bun', '-e', script], {
        cwd: process.cwd(),
        env: TEST_CHILD_ENV,
        timeoutMs: 5_000,
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('chat.completion.chunk')
      expect(result.stdout).toContain('systematic_skill')
    } finally {
      model.stop()
    }
  }, 10_000)
})

// Pins the third spawnOpencodeChild stdio invariant: stdin must be
// explicitly closed (`'ignore'`), never left as node's default open pipe.
// Against a real opencode-ai host, an open, unclosed stdin pipe made
// `opencode run` block waiting for EOF it would never receive — the 180s
// `runOpencode` hang this PR fixes. This test pins that fix without needing
// `opencode`, `bunx`, or network: the spawned child itself waits for stdin
// EOF and only then prints a marker and exits. With the shipped
// `stdio: ['ignore', ...]`, the child's stdin is `/dev/null` and reaches EOF
// immediately, so the child exits fast, well inside its own `timeoutMs`.
// Reverting to node's default open stdin pipe makes the child hang to its
// own `timeoutMs` and get killed (`exitCode -1`), exactly like the real
// host did — confirmed by temporarily removing the `'ignore'` and observing
// this test fail/time out, then restoring it and observing this test pass.
describe('spawnOpencodeChild stdin invariant', () => {
  test('closes stdin so the child sees EOF immediately instead of hanging', async () => {
    const script = `
      process.stdin.resume()
      process.stdin.on('end', () => {
        process.stdout.write('stdin-eof\\n')
        process.exit(0)
      })
    `

    const start = Date.now()
    const result = await spawnOpencodeChild(['bun', '-e', script], {
      cwd: process.cwd(),
      env: TEST_CHILD_ENV,
      timeoutMs: 3_000,
    })
    const elapsedMs = Date.now() - start

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('stdin-eof')
    // A closed stdin resolves near-instantly; a hang would only resolve at
    // (or past) the child's own timeoutMs above.
    expect(elapsedMs).toBeLessThan(3_000)
  }, 10_000)
})

// Pins the fix for the leak/hang `proc.kill()` alone would cause: a
// deliberately long-lived child that itself spawns a long-lived grandchild,
// both outliving a short `timeoutMs`. If `spawnOpencodeChild` only signaled
// the direct child, the grandchild would survive and this test would hang
// waiting for its stdio pipes to close (they never would). Reaping the
// whole process group lets both die together, so the promise resolves and
// the grandchild's pid is confirmed gone afterward.
describe('spawnOpencodeChild timeout path', () => {
  test('reaps the whole process group on timeout, leaving no descendant process behind', async () => {
    const script = `
      const { spawn } = require('node:child_process')
      const grandchild = spawn('sleep', ['9999'], { stdio: 'ignore' })
      process.stdout.write('grandchild-pid:' + grandchild.pid + '\\n')
      setInterval(() => {}, 1000)
    `

    const start = Date.now()
    const result = await spawnOpencodeChild(['bun', '-e', script], {
      cwd: process.cwd(),
      env: TEST_CHILD_ENV,
      timeoutMs: 500,
    })
    const elapsedMs = Date.now() - start

    // Returns (does not hang) within a bounded margin over its own timeout.
    expect(elapsedMs).toBeLessThan(10_000)
    expect(result.exitCode).toBe(-1)

    const match = /grandchild-pid:(\d+)/.exec(result.stdout)
    expect(match).not.toBeNull()
    const grandchildPid = Number(match?.[1])

    // Give the OS a brief moment to finish reaping after the group signal.
    await Bun.sleep(300)
    expect(() => process.kill(grandchildPid, 0)).toThrow()
  }, 15_000)
})

// Item 6 pinning test: `installTerminalSignalHandlers`'s SIGINT listener
// must NOT force-exit when nothing is live (this is the fix for the root
// cause of a spurious full-suite exit 130 -- the handler used to reap and
// `process.exit(130)` unconditionally, even with nothing to reap), but
// must still reap-and-exit when something (a registered
// `spawnOpencodeChild` child, per item 1) is live.
//
// Runs entirely inside an isolated `bun -e` child process: that process's
// own `process.listeners('SIGINT')` starts empty, so the before/after diff
// below cannot be confused by any other SIGINT listener already installed
// elsewhere in this bun test worker, and the listener is captured and
// invoked directly -- never via `process.emit` -- mirroring the technique
// documented in eval-runner.test.ts's "signal cleanup" test.
//
// Bidirectional proof: reverting the `if (!hasLiveOpencodeProcesses())
// return` early-return in `installTerminalSignalHandlers` makes case A
// below also reap-and-exit, flipping `CASE_A_EXIT_CALLS` to `1` and
// `CASE_A_THREW` to `true` -- this test then fails.
describe('terminal-signal safety net (nothing-live vs something-live)', () => {
  test('does not force-exit with an empty live set, but reaps and exits with a live child', () => {
    const script = `
      const priorSigintListeners = new Set(process.listeners('SIGINT'))
      const mod = await import(${JSON.stringify(FIXTURE_MODULE_URL)})

      const exitCalls = []
      const originalExit = process.exit
      process.exit = (code) => {
        exitCalls.push(code ?? 0)
        throw new Error('process.exit stub invoked')
      }

      // Triggers installTerminalSignalHandlers as a side effect and is
      // fully awaited, so its pid is evicted before this resolves -- the
      // live set is empty again by the time case A invokes the listener.
      await mod.spawnOpencodeChild(['bun', '-e', 'process.exit(0)'], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: 5000,
      })

      const installed = process
        .listeners('SIGINT')
        .filter((listener) => !priorSigintListeners.has(listener))
      if (installed.length !== 1) {
        throw new Error(
          'expected exactly 1 new SIGINT listener, got ' + installed.length,
        )
      }
      const [listener] = installed

      let threwA = false
      try {
        listener()
      } catch {
        threwA = true
      }
      process.stdout.write('CASE_A_EXIT_CALLS=' + exitCalls.length + '\\n')
      process.stdout.write('CASE_A_THREW=' + threwA + '\\n')

      // Case B: register one real live child (deliberately not awaited
      // before invoking the listener), so the reap path has something to
      // actually kill.
      const longLived = mod.spawnOpencodeChild(
        ['bun', '-e', 'setInterval(() => {}, 1000)'],
        {
          cwd: process.cwd(),
          env: { PATH: process.env.PATH ?? '' },
          timeoutMs: 60000,
        },
      )
      await new Promise((resolve) => setTimeout(resolve, 300))

      let threwB = false
      try {
        listener()
      } catch {
        threwB = true
      }
      process.stdout.write('CASE_B_EXIT_CALLS=' + exitCalls.length + '\\n')
      process.stdout.write('CASE_B_THREW=' + threwB + '\\n')

      await longLived
      process.exit = originalExit
    `

    const result = Bun.spawnSync(['bun', '-e', script], {
      env: TEST_CHILD_ENV,
      timeout: 15_000,
    })
    const stdout = result.stdout.toString()
    const stderr = result.stderr.toString()

    // Fails with the harness's own stderr attached: a failure here means the
    // *harness script* threw or crashed, and without stderr that failure is
    // otherwise undiagnosable (stdout alone would just show which of the
    // later CASE_A/CASE_B markers never got written).
    if (result.exitCode !== 0) {
      throw new Error(
        `harness script exited with code ${result.exitCode}: ${stderr}`,
      )
    }
    expect(stdout).toContain('CASE_A_EXIT_CALLS=0')
    expect(stdout).toContain('CASE_A_THREW=false')
    expect(stdout).toContain('CASE_B_EXIT_CALLS=1')
    expect(stdout).toContain('CASE_B_THREW=true')
  }, 20_000)
})

// Pin for item 2: multi-byte UTF-8 characters can split across chunk
// boundaries. Without `setEncoding('utf8')`, each `Buffer` arriving on
// `data` is decoded independently, so an incomplete lead byte in one chunk
// becomes a replacement character (U+FFFD) instead of being buffered until
// the rest of the sequence arrives in the next chunk.
//
// Bidirectional proof: temporarily removing spawnOpencodeChild's two
// `setEncoding('utf8')` calls (and reverting its data handlers to
// `chunk.toString()` on the raw `Buffer`) was confirmed to make this test
// fail -- `result.stdout` then contains U+FFFD instead of '€' -- before
// restoring the fix.
describe('spawnOpencodeChild UTF-8 chunk reassembly (item 2 pin)', () => {
  test('reassembles a multi-byte character split across two stdout chunks', async () => {
    // '€' (U+20AC) is 0xE2 0x82 0xAC in UTF-8. Writing the lead byte, then
    // sleeping, then the two continuation bytes forces two separate `data`
    // events on the receiving end instead of one coalesced read.
    const script = `
      process.stdout.write(Buffer.from([0xe2]))
      await new Promise((resolve) => setTimeout(resolve, 50))
      process.stdout.write(Buffer.from([0x82, 0xac]))
    `
    const result = await spawnOpencodeChild(['bun', '-e', script], {
      cwd: process.cwd(),
      env: TEST_CHILD_ENV,
      timeoutMs: 5_000,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('\u20ac')
  }, 10_000)
})

// Pin for item 5: startOpencodeProcess isn't directly testable host-free
// (its promise only resolves once a real `opencode serve` prints a listen
// URL), so this tests the shared `buildDetachedChildSpawnOptions` builder
// both `spawnOpencodeChild` and `startOpencodeProcess` construct their
// `spawn` options through -- proving the invariant for both call sites at
// once, and guaranteeing they cannot diverge (they call the same function).
describe('buildDetachedChildSpawnOptions (shared by spawnOpencodeChild and startOpencodeProcess, item 5 pin)', () => {
  test('always closes stdin and always keeps stdout/stderr piped, detached into its own group', () => {
    const options = buildDetachedChildSpawnOptions('/tmp/example', {
      PATH: '/usr/bin',
    })

    expect(options.detached).toBe(true)
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(options.cwd).toBe('/tmp/example')
    expect(options.env).toEqual({ PATH: '/usr/bin' })
  })

  // Mirrors the existing spawnOpencodeChild stdin-invariant test above
  // (~line 339): a real child spawned with these exact options must see
  // stdin EOF immediately, never node's default open pipe.
  test('a real child spawned with these options sees stdin EOF immediately instead of hanging', async () => {
    const script = `
      process.stdin.resume()
      process.stdin.on('end', () => {
        process.stdout.write('stdin-eof\\n')
        process.exit(0)
      })
    `

    const start = Date.now()
    const result = await new Promise<{ stdout: string; exitCode: number }>(
      (resolve) => {
        const child = spawn(
          'bun',
          ['-e', script],
          buildDetachedChildSpawnOptions(process.cwd(), TEST_CHILD_ENV),
        )
        let stdout = ''
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk
        })
        child.once('close', (code) => resolve({ stdout, exitCode: code ?? -1 }))
      },
    )
    const elapsedMs = Date.now() - start

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('stdin-eof')
    expect(elapsedMs).toBeLessThan(3_000)
  }, 10_000)
})

// Regression test for item 1's stale-pid bug: `finish()`'s at-settle
// eviction (evictRunOpencodeChildPid) only re-probes once, at the instant
// the direct child's stdio pipes close. If the child's own process group
// still has a member (e.g. a detached grandchild it spawned and then
// exited without waiting for) at that exact instant, the pid is retained
// -- and without pruning, stays retained for the rest of the worker's life
// even after that grandchild later exits on its own, permanently pinning
// `hasLiveOpencodeProcesses()` to true.
//
// Runs entirely inside an isolated `bun -e` harness process (its own fresh
// module graph, its own empty live-pid set) so this test's own real
// grandchild process can't be confused with anything another test file in
// this worker may have registered.
//
// Bidirectional proof: temporarily reverting `hasLiveOpencodeProcesses` (and
// `killLiveOpencodeHostsSync`) to skip `pruneLiveOpencodeProcesses()` was
// confirmed to make this test fail -- `HAS_LIVE_AFTER_KILL` stays `true`
// instead of flipping to `false` -- before restoring the fix.
describe('stale run-child pid pruning (item 1 regression: grandchild still draining at settle time)', () => {
  test('hasLiveOpencodeProcesses re-probes and prunes a pid once its process group has since emptied', () => {
    const script = `
      const mod = await import(${JSON.stringify(FIXTURE_MODULE_URL)})

      const childScript = \`
        const { spawn } = require('node:child_process')
        const grandchild = spawn('sleep', ['30'], { stdio: 'ignore' })
        process.stdout.write('grandchild-pid:' + grandchild.pid + '\\\\n')
        process.exit(0)
      \`

      let grandchildPid
      try {
        const result = await mod.spawnOpencodeChild(['bun', '-e', childScript], {
          cwd: process.cwd(),
          env: { PATH: process.env.PATH ?? '' },
          timeoutMs: 5000,
        })
        const match = /grandchild-pid:(\\d+)/.exec(result.stdout)
        if (!match) {
          throw new Error('no grandchild pid in stdout: ' + JSON.stringify(result))
        }
        grandchildPid = Number(match[1])

        // The direct child already exited (its stdio closed, so
        // spawnOpencodeChild's promise above already resolved), but the
        // grandchild -- still in the same process group -- is a 30s sleep,
        // so the group is still non-empty right now.
        process.stdout.write(
          'HAS_LIVE_BEFORE_KILL=' + mod.hasLiveOpencodeProcesses() + '\\n',
        )

        process.kill(grandchildPid, 'SIGKILL')
        // Give the OS a brief moment to finish reaping after the signal.
        await new Promise((resolve) => setTimeout(resolve, 300))

        process.stdout.write(
          'HAS_LIVE_AFTER_KILL=' + mod.hasLiveOpencodeProcesses() + '\\n',
        )
      } finally {
        if (grandchildPid) {
          try {
            process.kill(grandchildPid, 'SIGKILL')
          } catch {}
        }
      }
    `

    const result = Bun.spawnSync(['bun', '-e', script], {
      env: TEST_CHILD_ENV,
      timeout: 15_000,
    })
    const stdout = result.stdout.toString()
    const stderr = result.stderr.toString()

    if (result.exitCode !== 0) {
      throw new Error(
        `harness script exited with code ${result.exitCode}: ${stderr}`,
      )
    }
    expect(stdout).toContain('HAS_LIVE_BEFORE_KILL=true')
    expect(stdout).toContain('HAS_LIVE_AFTER_KILL=false')
  }, 20_000)
})
