import { describe, expect, test } from 'bun:test'

import {
  assertMixedVersionProbeEvents,
  extractSkillNameFromPrompt,
  type ProbeEvent,
  scriptedResponseChunks,
  startScriptedSkillModelServer,
  withScriptedProvider,
} from '../integration/fixtures/receipt-workflow-host.js'

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

// Regression test for the Bun.serve + Bun.spawnSync deadlock: `runOpencode`
// previously blocked its own thread with a synchronous spawn while the
// scripted model server (also on that thread) needed to answer the spawned
// child's HTTP request — every call hung to TIMEOUT_MS. This drives the
// server through the SAME async-spawn mechanism `runOpencode` now uses
// (`Bun.spawn`, never `Bun.spawnSync`) and asserts a real response arrives
// well inside a short bound, never a timeout. It needs no `opencode` or
// `bunx` on `PATH` — the spawned child only performs a `fetch` against the
// scripted server, exactly like `runOpencode`'s CLI child does once it
// reaches the model.
describe('scripted server survives an async-spawned child (deadlock regression)', () => {
  test('a Bun.spawn child can fetch a real response from the scripted server while the test thread stays live', async () => {
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
      const proc = Bun.spawn(['bun', '-e', script], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timeout = setTimeout(() => proc.kill(), 5_000)
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ])
      clearTimeout(timeout)

      expect(exitCode).toBe(0)
      expect(stdout).toContain('chat.completion.chunk')
      expect(stdout).toContain('systematic_skill')
    } finally {
      model.stop()
    }
  }, 10_000)
})
