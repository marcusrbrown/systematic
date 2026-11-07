import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  type ChatRequest,
  CONNECT_PROBE_MARKER,
  type ConnectIsolationObservation,
  connectIsolationLayout,
  createConnectIsolationScript,
  evaluateConnectIsolationProof,
  type IsolationHostTools,
  parseDenyBlock,
  plantConnectExternalCheckout,
  plantConnectGitRepo,
  plantConnectIsolationFixture,
  readConnectSideEffects,
  withoutDenyEntries,
  withoutExternalDirectoryAllow,
} from '../helpers/connect-delegated-proof.js'

const HOST_TOOLS: IsolationHostTools = {
  shell: 'bash',
  write: 'write',
  edit: 'edit',
  webfetch: 'webfetch',
  read: 'read',
}

const DENIED_TEXT =
  'The user has specified a rule which prevents you from using this specific tool call.'

function toolMessage(text: string) {
  return { role: 'tool', content: text }
}

function childRequestWithResults(
  results: readonly string[],
  offered: readonly string[] = ['read', 'grep'],
): ChatRequest {
  return {
    tools: offered.map((name) => ({ function: { name } })),
    messages: [
      { role: 'system', content: 'researcher system prompt' },
      { role: 'user', content: 'CHILD-PROMPT' },
      ...results.map((text) => toolMessage(text)),
    ],
  }
}

function healthyObservation(): ConnectIsolationObservation {
  return {
    requestCount: 6,
    requestCap: 16,
    parentRequests: [
      {
        tools: [{ function: { name: 'task' } }],
        messages: [
          { role: 'user', content: 'dispatch' },
          toolMessage(`CHILD-FOUND ${CONNECT_PROBE_MARKER}`),
        ],
      },
    ],
    childRequests: [
      childRequestWithResults([]),
      childRequestWithResults([
        DENIED_TEXT,
        DENIED_TEXT,
        DENIED_TEXT,
        DENIED_TEXT,
        `# note\n${CONNECT_PROBE_MARKER}\n`,
      ]),
    ],
    attempts: ['shell', 'write', 'edit', 'webfetch', 'read'],
    sideEffects: {
      writtenPaths: [],
      editTargetChanged: false,
      fetchHits: 0,
      extraWorktrees: 0,
    },
    parentAnswer: `PARENT-FINAL ${CONNECT_PROBE_MARKER}`,
  }
}

describe('evaluateConnectIsolationProof', () => {
  test('passes when every denied call is refused, nothing reached disk, and the read marker reaches the parent answer', () => {
    expect(evaluateConnectIsolationProof(healthyObservation())).toEqual({
      ok: true,
    })
  })

  test('names an isolation breach when a denied write left a file behind', () => {
    const verdict = evaluateConnectIsolationProof({
      ...healthyObservation(),
      sideEffects: {
        writtenPaths: ['/tmp/project/isolation/shell-marker.txt'],
        editTargetChanged: false,
        fetchHits: 0,
        extraWorktrees: 0,
      },
    })

    expect(verdict).toMatchObject({ ok: false, code: 'isolation-breach' })
    if (!verdict.ok) expect(verdict.message).toContain('shell-marker.txt')
  })

  test('names an isolation breach when the planted edit target changed', () => {
    const verdict = evaluateConnectIsolationProof({
      ...healthyObservation(),
      sideEffects: {
        writtenPaths: [],
        editTargetChanged: true,
        fetchHits: 0,
        extraWorktrees: 0,
      },
    })

    expect(verdict).toMatchObject({ ok: false, code: 'isolation-breach' })
    if (!verdict.ok) expect(verdict.message).toContain('edit target')
  })

  test('names an isolation breach when the denied web fetch reached the server', () => {
    const verdict = evaluateConnectIsolationProof({
      ...healthyObservation(),
      sideEffects: {
        writtenPaths: [],
        editTargetChanged: false,
        fetchHits: 1,
        extraWorktrees: 0,
      },
    })

    expect(verdict).toMatchObject({ ok: false, code: 'isolation-breach' })
    if (!verdict.ok) expect(verdict.message).toContain('web fetch')
  })

  test('names an isolation breach when a git worktree was added to the project', () => {
    const verdict = evaluateConnectIsolationProof({
      ...healthyObservation(),
      sideEffects: {
        writtenPaths: [],
        editTargetChanged: false,
        fetchHits: 0,
        extraWorktrees: 1,
      },
    })

    expect(verdict).toMatchObject({ ok: false, code: 'isolation-breach' })
    if (!verdict.ok) expect(verdict.message).toContain('worktree')
  })

  test('fails when a denied call returned something that is not a refusal, even with no side effect', () => {
    const observation = healthyObservation()
    const verdict = evaluateConnectIsolationProof({
      ...observation,
      childRequests: [
        childRequestWithResults([]),
        childRequestWithResults([
          DENIED_TEXT,
          'File written successfully.',
          DENIED_TEXT,
          DENIED_TEXT,
          `# note\n${CONNECT_PROBE_MARKER}\n`,
        ]),
      ],
    })

    expect(verdict).toMatchObject({ ok: false, code: 'attempt-ran' })
    if (!verdict.ok) expect(verdict.message).toContain('write')
  })

  test('fails when the allowed read does not deliver the planted marker', () => {
    const observation = healthyObservation()
    const verdict = evaluateConnectIsolationProof({
      ...observation,
      childRequests: [
        childRequestWithResults([]),
        childRequestWithResults([
          DENIED_TEXT,
          DENIED_TEXT,
          DENIED_TEXT,
          DENIED_TEXT,
          'Error: file not found',
        ]),
      ],
    })

    expect(verdict).toMatchObject({ ok: false, code: 'read-not-delivered' })
  })

  test('fails when the child stopped before every attempt was answered', () => {
    const observation = healthyObservation()
    const verdict = evaluateConnectIsolationProof({
      ...observation,
      childRequests: [
        childRequestWithResults([]),
        childRequestWithResults([DENIED_TEXT, DENIED_TEXT]),
      ],
    })

    expect(verdict).toMatchObject({ ok: false, code: 'attempts-incomplete' })
  })

  test('fails with no-child-request when the parent never dispatched the researcher', () => {
    const verdict = evaluateConnectIsolationProof({
      ...healthyObservation(),
      childRequests: [],
    })

    expect(verdict).toMatchObject({ ok: false, code: 'no-child-request' })
  })

  test('fails with request-cap when the model was asked more often than the cap', () => {
    const verdict = evaluateConnectIsolationProof({
      ...healthyObservation(),
      requestCount: 17,
    })

    expect(verdict).toMatchObject({ ok: false, code: 'request-cap' })
  })

  test('fails when the parent answer is missing, or lacks the marker', () => {
    const missing = evaluateConnectIsolationProof({
      ...healthyObservation(),
      parentAnswer: undefined,
    })
    const wrong = evaluateConnectIsolationProof({
      ...healthyObservation(),
      parentAnswer: 'PARENT-FINAL NO-PATH',
    })

    expect(missing).toMatchObject({ ok: false, code: 'no-final-answer' })
    expect(wrong).toMatchObject({
      ok: false,
      code: 'final-answer-missing-marker',
    })
  })
})

describe('createConnectIsolationScript', () => {
  const layout = connectIsolationLayout('/fixture/project')

  function scriptFor() {
    return createConnectIsolationScript({
      layout,
      hostTools: HOST_TOOLS,
      fetchUrl: 'http://127.0.0.1:9/probe',
      dispatch: { tool: 'task', arguments: { prompt: 'CHILD-PROMPT' } },
      isChildRequest: (request) =>
        JSON.stringify(request.messages).includes('CHILD-PROMPT'),
    })
  }

  test('the parent dispatches once and then answers with the marker its tool result carried', () => {
    const script = scriptFor()
    const first = script.respond({
      tools: [{ function: { name: 'task' } }],
      messages: [{ role: 'user', content: 'start' }],
    })
    const second = script.respond({
      tools: [{ function: { name: 'task' } }],
      messages: [
        { role: 'user', content: 'start' },
        toolMessage(`CHILD-FOUND ${CONNECT_PROBE_MARKER}`),
      ],
    })

    expect(first).toMatchObject({ toolCalls: [{ name: 'task' }] })
    expect(second).toEqual({
      text: `PARENT-FINAL ${CONNECT_PROBE_MARKER}`,
    })
  })

  test('the child tries shell, write, edit and web fetch in order, then reads, then reports the marker', () => {
    const script = scriptFor()
    const names: string[] = []
    const results: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const turn = script.respond(
        childRequestWithResults(results, ['read', 'grep']),
      )
      if (!('toolCalls' in turn)) throw new Error('expected a tool call')
      names.push(turn.toolCalls[0]?.name ?? '')
      results.push(
        i === 4 ? `note ${CONNECT_PROBE_MARKER}` : 'refused: permission denied',
      )
    }
    const done = script.respond(childRequestWithResults(results))

    expect(names).toEqual(['bash', 'write', 'edit', 'webfetch', 'read'])
    expect(done).toEqual({ text: `CHILD-FOUND ${CONNECT_PROBE_MARKER}` })
    expect(script.observation().childRequests).toHaveLength(6)
  })

  test('the read argument key follows the host, and the extra tools a host lists are tried before the read', () => {
    const script = createConnectIsolationScript({
      layout,
      hostTools: { ...HOST_TOOLS, execute: 'execute', websearch: 'websearch' },
      readPathKey: 'path',
      fetchUrl: 'http://127.0.0.1:9/probe',
      dispatch: { tool: 'task', arguments: {} },
      isChildRequest: () => true,
    })
    const calls: { name: string; arguments: Record<string, unknown> }[] = []
    const results: string[] = []
    for (let i = 0; i < 7; i += 1) {
      const turn = script.respond(childRequestWithResults(results))
      if (!('toolCalls' in turn)) throw new Error('expected a tool call')
      const call = turn.toolCalls[0]
      if (call === undefined) throw new Error('expected a call')
      calls.push({ name: call.name, arguments: call.arguments })
      results.push('refused: permission denied')
    }

    expect(calls.map((call) => call.name)).toEqual([
      'bash',
      'write',
      'edit',
      'webfetch',
      'execute',
      'websearch',
      'read',
    ])
    expect(calls.at(-1)?.arguments).toEqual({ path: layout.readTarget })
    expect(script.observation().attempts).toEqual([
      'shell',
      'write',
      'edit',
      'webfetch',
      'execute',
      'websearch',
      'read',
    ])
  })

  test('the execute call carries the code a test supplies, and falls back to a fetch of the denied URL', () => {
    const run = (executeCode?: string) => {
      const script = createConnectIsolationScript({
        layout,
        hostTools: { ...HOST_TOOLS, execute: 'execute' },
        fetchUrl: 'http://127.0.0.1:9/probe',
        ...(executeCode !== undefined && { executeCode }),
        dispatch: { tool: 'task', arguments: {} },
        isChildRequest: () => true,
      })
      const results = ['r', 'r', 'r', 'r']
      const turn = script.respond(childRequestWithResults(results))
      if (!('toolCalls' in turn)) throw new Error('expected a tool call')
      return turn.toolCalls[0]?.arguments
    }

    expect(run('return 1')).toEqual({ code: 'return 1' })
    expect(JSON.stringify(run())).toContain('fetch(')
  })

  test('a request that offers no tools is answered as the session title and recorded nowhere', () => {
    const script = scriptFor()
    const turn = script.respond({ messages: [{ role: 'user', content: 'x' }] })

    expect(turn).toEqual({ text: 'Scripted title' })
    expect(script.observation().childRequests).toHaveLength(0)
    expect(script.observation().parentRequests).toHaveLength(0)
  })
})

describe('the planted fixture and its side-effect readback', () => {
  function withProject<T>(run: (projectDir: string) => T): T {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-connect-proof-unit-'),
    )
    try {
      return run(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a fresh fixture reads back clean, and each kind of write is noticed', () => {
    withProject((projectDir) => {
      const layout = connectIsolationLayout(projectDir)
      plantConnectIsolationFixture(layout)

      expect(readConnectSideEffects(layout, 0)).toEqual({
        writtenPaths: [],
        editTargetChanged: false,
        fetchHits: 0,
        extraWorktrees: 0,
      })
      expect(fs.readFileSync(layout.readTarget, 'utf8')).toContain(
        CONNECT_PROBE_MARKER,
      )

      fs.writeFileSync(layout.shellMarker, 'x')
      fs.writeFileSync(layout.writeMarker, 'x')
      fs.writeFileSync(layout.editTarget, 'CHANGED')

      expect(readConnectSideEffects(layout, 2)).toEqual({
        writtenPaths: [layout.shellMarker, layout.writeMarker],
        editTargetChanged: true,
        fetchHits: 2,
        extraWorktrees: 0,
      })
    })
  })

  test('a project that is a git repository reports the worktrees added to it', () => {
    withProject((projectDir) => {
      const layout = connectIsolationLayout(projectDir)
      plantConnectIsolationFixture(layout)
      plantConnectGitRepo(projectDir)
      expect(readConnectSideEffects(layout, 0).extraWorktrees).toBe(0)

      const added = path.join(path.dirname(projectDir), 'added-worktree')
      const result = spawnSync('git', ['worktree', 'add', '-q', added], {
        cwd: projectDir,
      })
      expect(result.status).toBe(0)

      expect(readConnectSideEffects(layout, 0).extraWorktrees).toBe(1)
      fs.rmSync(added, { recursive: true, force: true })
    })
  })
})

describe('plantConnectExternalCheckout', () => {
  test('puts the note in a committed git checkout and points the read at it', () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-connect-proof-external-'),
    )
    try {
      const layout = connectIsolationLayout(path.join(dir, 'project'))
      const checkout = path.join(dir, 'checkout')

      const external = plantConnectExternalCheckout(layout, checkout)

      expect(external.readTarget).toBe(
        path.join(checkout, 'docs/solutions/external-note.md'),
      )
      expect(external.shellMarker).toBe(layout.shellMarker)
      expect(fs.readFileSync(external.readTarget, 'utf8')).toContain(
        CONNECT_PROBE_MARKER,
      )
      expect(fs.existsSync(path.join(checkout, '.git'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('withoutDenyEntries', () => {
  const definition = [
    '---',
    'name: probe',
    'description: Probe',
    'tools: Read, Grep, Glob',
    'permission:',
    '  bash: deny',
    '  edit: deny',
    '  webfetch: deny',
    '---',
    '',
    'Body.',
    '',
  ].join('\n')

  test('removes the permission block and keeps the rest of the definition', () => {
    const stripped = withoutDenyEntries(definition)

    expect(stripped).not.toContain('permission:')
    expect(stripped).not.toContain('deny')
    expect(stripped).toContain('tools: Read, Grep, Glob')
    expect(stripped).toContain('Body.')
  })

  test('refuses a definition that has no deny entries, so a control cannot pass vacuously', () => {
    expect(() => withoutDenyEntries('---\nname: x\n---\n\nBody.\n')).toThrow(
      /no permission block/,
    )
  })

  test('parseDenyBlock lists the denied actions of a definition', () => {
    expect(parseDenyBlock(definition)).toEqual(['bash', 'edit', 'webfetch'])
    expect(parseDenyBlock('---\nname: x\n---\n')).toEqual([])
  })
})

describe('withoutExternalDirectoryAllow', () => {
  const definition =
    '---\nname: probe\npermission:\n  bash: deny\n  external_directory: allow\n---\n\nBody.\n'

  test('removes only the external_directory entry', () => {
    const stripped = withoutExternalDirectoryAllow(definition)

    expect(stripped).not.toContain('external_directory')
    expect(stripped).toContain('  bash: deny')
  })

  test('refuses a definition without the entry, so the control cannot pass vacuously', () => {
    expect(() =>
      withoutExternalDirectoryAllow('---\nname: x\n---\n\nBody.\n'),
    ).toThrow(/no external_directory allow/)
  })
})
