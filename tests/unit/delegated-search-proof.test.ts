import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  assertDelegatedSearchProof,
  type ChatRequest,
  createDelegatedSearchScript,
  DEFAULT_DELEGATED_SEARCH_MODE,
  DELEGATED_EXTERNAL_FIXTURE,
  DELEGATED_SEARCH_FIXTURE,
  DELEGATED_SEARCH_REQUEST_CAP,
  type DelegatedSearchObservation,
  EXTERNAL_DELEGATED_SEARCH_MODE,
  evaluateDelegatedSearchProof,
  hasResearcherSystemMarker,
  PARENT_FINAL_MARKER,
  plantDelegatedExternalFixture,
  plantDelegatedSearchFixture,
  researcherSystemMarker,
  systemTextOf,
} from '../helpers/delegated-search-proof.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const PATH = DELEGATED_SEARCH_FIXTURE.solution.path
const BRAINSTORM_PATH = DELEGATED_SEARCH_FIXTURE.brainstorm.path
const MARKER = 'You are the test researcher'
const SEARCH_TOOL = 'systematic_search'

const SOLUTION_HIT = `1. ${PATH}\n   Title: Zebra crossing flake | Kind: solution | Status: active\n   Snippet: The zebra flake appears when retries overlap.`
const BRAINSTORM_HIT = `2. ${BRAINSTORM_PATH}\n   Title: Zebra crossing | Kind: brainstorm | Status: abandoned\n   Snippet: An abandoned idea: retry the zebra flake with a longer delay.`
const ALL_HEADER =
  'Search "zebra flake retry": 2 docs, 2 hits. Corpus: solution 1, plan none, brainstorm 1, ideation none.'

const FOUND_MESSAGE = `${ALL_HEADER}\n\n${SOLUTION_HIT}\n\n${BRAINSTORM_HIT}`
const BOTH_PATHS = `${PATH} ${BRAINSTORM_PATH}`
const FINAL_ANSWER = `${PARENT_FINAL_MARKER} ${BOTH_PATHS}`

function tool(name: string) {
  return { type: 'function', function: { name } }
}

function request(
  messages: { role: string; content: string }[],
  toolNames: string[] = [SEARCH_TOOL, 'read'],
): ChatRequest {
  return { tools: toolNames.map(tool), messages }
}

function childFirst(toolNames?: string[]): ChatRequest {
  return request(
    [
      { role: 'system', content: `${MARKER} for past work.` },
      { role: 'user', content: 'find the zebra flake' },
    ],
    toolNames,
  )
}

function childNext(toolText: string): ChatRequest {
  return request([
    { role: 'system', content: `${MARKER} for past work.` },
    { role: 'user', content: 'find the zebra flake' },
    { role: 'assistant', content: '' },
    { role: 'tool', content: toolText },
  ])
}

function parentFirst(): ChatRequest {
  return request(
    [
      { role: 'system', content: 'You are the host.' },
      { role: 'user', content: 'dispatch' },
    ],
    ['task', SEARCH_TOOL],
  )
}

function parentFinal(toolText: string): ChatRequest {
  return request(
    [
      { role: 'system', content: 'You are the host.' },
      { role: 'user', content: 'dispatch' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: toolText },
    ],
    ['task', SEARCH_TOOL],
  )
}

function passing(): DelegatedSearchObservation {
  return {
    requestCount: 5,
    requestCap: DELEGATED_SEARCH_REQUEST_CAP,
    childRequests: [childFirst(), childNext(FOUND_MESSAGE)],
    parentRequests: [
      parentFirst(),
      parentFinal(`<task_result>CHILD-FOUND ${BOTH_PATHS}</task_result>`),
    ],
    parentAnswer: FINAL_ANSWER,
  }
}

describe('evaluateDelegatedSearchProof', () => {
  test('a delivered result and a parent answer naming the path pass', () => {
    expect(evaluateDelegatedSearchProof(passing())).toEqual({ ok: true })
    expect(() => assertDelegatedSearchProof(passing())).not.toThrow()
  })

  test('no child request fails and says the parent never dispatched', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'no-child-request' })
  })

  test('a child that was not offered the tool fails and the diagnostic names the missing advertisement', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [childFirst(['read', 'grep'])],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'tool-not-advertised' })
    if (!verdict.ok) {
      expect(verdict.message).toContain('did not advertise systematic_search')
      expect(verdict.message).toContain('read, grep')
    }
  })

  test('a child that answers in text without calling the tool fails with a no-tool-call message', () => {
    const textOnly = request([
      { role: 'system', content: MARKER },
      { role: 'user', content: 'find it' },
      { role: 'assistant', content: 'I grepped docs/solutions myself.' },
    ])
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [childFirst(), textOnly],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'no-tool-call' })
    if (!verdict.ok) {
      expect(verdict.message).toContain(
        'answered without calling systematic_search',
      )
    }
  })

  test('offering the tool is not enough: an advertised tool with no delivered result fails', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [childFirst()],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'no-tool-call' })
  })

  test('a delivered result passes even when the first request listed no tool: advertisement is a diagnostic only', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [childFirst(['read']), childNext(FOUND_MESSAGE)],
    })
    expect(verdict).toEqual({ ok: true })
  })

  test('a tool message that starts with Error: fails, even when it names the path', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [childFirst(), childNext(`Error: could not read ${PATH}`)],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'error-result' })
  })

  test('a tool message that does not start with Search " fails', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [childFirst(), childNext(`1 hit: ${PATH}`)],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'bad-header' })
  })

  test('a Search " message without the planted path fails', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [
        childFirst(),
        childNext('Search "zebra flake retry": 1 doc, 0 hits.'),
      ],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'path-missing' })
  })

  test('a child that searched only solutions lacks the brainstorm and the verdict names its path', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [
        childFirst(),
        childNext(
          `Search "zebra flake retry": 1 doc, 1 hit. Corpus: docs/solutions.\n\n${SOLUTION_HIT}`,
        ),
      ],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'path-missing' })
    if (!verdict.ok) expect(verdict.message).toContain(BRAINSTORM_PATH)
  })

  test('a different planted brainstorm path can be required', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      plantedBrainstormPath: 'docs/brainstorms/other.md',
    })
    expect(verdict).toMatchObject({ ok: false, code: 'path-missing' })
  })

  test('the brainstorm hit must print Kind: brainstorm', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [
        childFirst(),
        childNext(FOUND_MESSAGE.replace('Kind: brainstorm', 'Kind: plan')),
      ],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'bad-label' })
    if (!verdict.ok) expect(verdict.message).toContain('Kind: brainstorm')
  })

  test('the brainstorm hit must print Status: abandoned', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [
        childFirst(),
        childNext(
          FOUND_MESSAGE.replace('Status: abandoned', 'Status: unspecified'),
        ),
      ],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'bad-label' })
    if (!verdict.ok) expect(verdict.message).toContain('Status: abandoned')
  })

  test('labels on some other hit do not stand in for the brainstorm hit', () => {
    const wrongBrainstormLine = BRAINSTORM_HIT.replace(
      'Kind: brainstorm | Status: abandoned',
      'Kind: plan | Status: active',
    )
    const message = `${ALL_HEADER}\n\n3. docs/plans/other.md\n   Title: Other | Kind: brainstorm | Status: abandoned\n\n${SOLUTION_HIT}\n\n${wrongBrainstormLine}`
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [childFirst(), childNext(message)],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'bad-label' })
  })

  test('a brainstorm path that is only quoted in a snippet has no hit labels and fails', () => {
    const message = `${ALL_HEADER}\n\n${SOLUTION_HIT.replace('The zebra flake appears when retries overlap.', `See ${BRAINSTORM_PATH}.`)}`
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [childFirst(), childNext(message)],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'bad-label' })
  })

  test('a truncated message still passes when both hits are complete before the cut', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [
        childFirst(),
        childNext(
          `${FOUND_MESSAGE}\n[Systematic: search output truncated at 16 KB]`,
        ),
      ],
    })
    expect(verdict).toEqual({ ok: true })
  })

  test('a message cut before the brainstorm hit labels fails', () => {
    const cut = `${ALL_HEADER}\n\n${SOLUTION_HIT}\n\n2. ${BRAINSTORM_PATH}\n[Systematic: search output truncated at 16 KB]`
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [childFirst(), childNext(cut)],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'bad-label' })
  })

  test('a parent answer that names only the solution fails and the verdict names the brainstorm path', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      parentRequests: [
        parentFirst(),
        parentFinal(`<task_result>CHILD-FOUND ${PATH}</task_result>`),
      ],
    })
    expect(verdict).toMatchObject({
      ok: false,
      code: 'parent-answer-missing-path',
    })
    if (!verdict.ok) expect(verdict.message).toContain(BRAINSTORM_PATH)
  })

  test('a parent whose last request lacks the path fails', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      parentRequests: [
        parentFirst(),
        parentFinal('<task_result>nothing</task_result>'),
      ],
    })
    expect(verdict).toMatchObject({
      ok: false,
      code: 'parent-answer-missing-path',
    })
  })

  test('a solution path that is only quoted in another hit snippet has no hit labels and fails', () => {
    const quoting = BRAINSTORM_HIT.replace(
      'An abandoned idea: retry the zebra flake with a longer delay.',
      `See ${PATH}.`,
    )
    const message = `${ALL_HEADER}\n\n${quoting}`
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [childFirst(), childNext(message)],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'bad-label' })
    if (!verdict.ok) expect(verdict.message).toContain(PATH)
  })

  test('the solution hit must print Kind: solution', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [
        childFirst(),
        childNext(FOUND_MESSAGE.replace('Kind: solution', 'Kind: plan')),
      ],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'bad-label' })
    if (!verdict.ok) expect(verdict.message).toContain('Kind: solution')
  })

  test('a final answer that omits the brainstorm path fails even when the parent received both', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      parentAnswer: `${PARENT_FINAL_MARKER} ${PATH}`,
    })
    expect(verdict).toMatchObject({
      ok: false,
      code: 'final-answer-missing-path',
    })
    if (!verdict.ok) expect(verdict.message).toContain(BRAINSTORM_PATH)
  })

  test('a final answer that omits the solution path fails', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      parentAnswer: `${PARENT_FINAL_MARKER} ${BRAINSTORM_PATH}`,
    })
    expect(verdict).toMatchObject({
      ok: false,
      code: 'final-answer-missing-path',
    })
    if (!verdict.ok) expect(verdict.message).toContain(PATH)
  })

  test('a final answer without the parent marker fails', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      parentAnswer: BOTH_PATHS,
    })
    expect(verdict).toMatchObject({ ok: false, code: 'no-final-answer' })
  })

  test('a run that captured no final answer fails', () => {
    const { parentAnswer: _omitted, ...withoutAnswer } = passing()
    const verdict = evaluateDelegatedSearchProof(withoutAnswer)
    expect(verdict).toMatchObject({ ok: false, code: 'no-final-answer' })
    if (!verdict.ok) expect(verdict.message).toContain('no message')
  })

  test('a parent that never saw the result back fails', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      parentRequests: [parentFirst()],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'no-parent-final' })
  })

  test('more requests than the cap fail before anything else is read', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      requestCount: DELEGATED_SEARCH_REQUEST_CAP + 1,
    })
    expect(verdict).toMatchObject({ ok: false, code: 'request-cap' })
  })

  test('assert throws with the failure code and message', () => {
    expect(() =>
      assertDelegatedSearchProof({ ...passing(), childRequests: [] }),
    ).toThrow(/\[no-child-request\].*never dispatched/)
  })

  test('a different planted solution path can be required', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      plantedPath: 'docs/solutions/other.md',
    })
    expect(verdict).toMatchObject({ ok: false, code: 'path-missing' })
  })
})

describe('createDelegatedSearchScript', () => {
  function script() {
    return createDelegatedSearchScript({
      dispatch: { tool: 'task', arguments: { subagent_type: 'researcher' } },
      isChildRequest: (r) => hasResearcherSystemMarker(r, MARKER),
    })
  }

  test('runs the four turns and the recorded run passes the proof', () => {
    const s = script()
    const title = s.respond({
      tools: [],
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(title).toEqual({ text: 'Scripted title' })

    expect(s.respond(parentFirst())).toEqual({
      toolCalls: [
        {
          id: 'delegated-dispatch-call',
          name: 'task',
          arguments: { subagent_type: 'researcher' },
        },
      ],
    })

    expect(s.respond(childFirst())).toEqual({
      toolCalls: [
        {
          id: 'delegated-search-call',
          name: SEARCH_TOOL,
          arguments: DELEGATED_SEARCH_FIXTURE.searchArguments,
        },
      ],
    })
    // The scripted child searches every kind, so the brainstorm is reachable.
    expect(DELEGATED_SEARCH_FIXTURE.searchArguments.kind).toBe('all')

    expect(s.respond(childNext(FOUND_MESSAGE))).toEqual({
      text: `CHILD-FOUND ${BOTH_PATHS}`,
    })

    // The parent's second request has a tool message but no researcher
    // marker, so it must not be taken for a child request.
    expect(
      s.respond(
        parentFinal(`<task_result>CHILD-FOUND ${BOTH_PATHS}</task_result>`),
      ),
    ).toEqual({ text: `PARENT-FINAL ${BOTH_PATHS}` })

    const observation = s.observation()
    expect(observation.requestCount).toBe(5)
    expect(observation.childRequests).toHaveLength(2)
    expect(observation.parentRequests).toHaveLength(2)
    // The host returns the parent's scripted answer as its final message.
    expect(
      evaluateDelegatedSearchProof({
        ...observation,
        parentAnswer: `${PARENT_FINAL_MARKER} ${BOTH_PATHS}`,
      }),
    ).toEqual({ ok: true })
  })

  test('the child echoes each path once, in the order the result lists them', () => {
    const s = script()
    const doubled = `${FOUND_MESSAGE}\n   Successor: ${PATH}`
    expect(s.respond(childNext(doubled))).toEqual({
      text: `CHILD-FOUND ${BOTH_PATHS}`,
    })
  })

  test('a child whose result names no path echoes a marker the proof rejects', () => {
    const s = script()
    expect(s.respond(childNext('Search "x": 1 doc, 0 hits.'))).toEqual({
      text: 'CHILD-FOUND NO-PATH',
    })
  })

  test('a child offered no search tool answers in text, and the proof names the missing advertisement', () => {
    const s = script()
    s.respond(parentFirst())
    expect(s.respond(childFirst(['read']))).toEqual({
      text: 'CHILD-ANSWERED-WITHOUT-SEARCH',
    })
    s.respond(
      parentFinal('<task_result>CHILD-ANSWERED-WITHOUT-SEARCH</task_result>'),
    )

    expect(evaluateDelegatedSearchProof(s.observation())).toMatchObject({
      ok: false,
      code: 'tool-not-advertised',
    })
  })

  test('the parent dispatches once; a second plain parent turn is reported, not re-dispatched', () => {
    const s = script()
    s.respond(parentFirst())
    expect(s.respond(parentFirst())).toEqual({ text: 'PARENT-UNEXPECTED-TURN' })
  })

  test('requests past the cap get a terminal text and the proof fails with the cap', () => {
    const s = createDelegatedSearchScript({
      dispatch: { tool: 'task', arguments: {} },
      isChildRequest: () => false,
      requestCap: 3,
    })
    s.respond(parentFirst())
    s.respond(parentFirst())
    s.respond(parentFirst())
    expect(s.respond(parentFirst())).toEqual({ text: 'REQUEST-CAP-EXCEEDED' })
    expect(evaluateDelegatedSearchProof(s.observation())).toMatchObject({
      ok: false,
      code: 'request-cap',
    })
  })
})

describe('default mode', () => {
  test("is today's constants, so the v1, v2 and Pi proofs stay byte-stable", () => {
    expect(DEFAULT_DELEGATED_SEARCH_MODE.headerPrefix).toBe('Search "')
    expect(DEFAULT_DELEGATED_SEARCH_MODE.pathPattern.source).toBe(
      'docs\\/[a-z]+\\/[\\w.-]+\\.md',
    )
    expect(DEFAULT_DELEGATED_SEARCH_MODE.pathPattern.flags).toBe('g')
    expect(DEFAULT_DELEGATED_SEARCH_MODE.searchArguments).toEqual({
      query: 'zebra flake retry',
      kind: 'all',
    })
    expect(DEFAULT_DELEGATED_SEARCH_MODE.expectedLabels).toEqual([
      { path: 'solution', labels: ['Kind: solution'] },
      {
        path: 'brainstorm',
        labels: ['Kind: brainstorm', 'Status: abandoned'],
      },
    ])
    // The fixture's own search arguments are the default mode's.
    expect(JSON.stringify(DEFAULT_DELEGATED_SEARCH_MODE.searchArguments)).toBe(
      JSON.stringify(DELEGATED_SEARCH_FIXTURE.searchArguments),
    )
  })

  test('the observation a default script records has no mode key', () => {
    const s = createDelegatedSearchScript({
      dispatch: { tool: 'task', arguments: {} },
      isChildRequest: (r) => hasResearcherSystemMarker(r, MARKER),
    })
    expect('mode' in s.observation()).toBe(false)
  })

  test('an external reply is not a pass in the default mode', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...passing(),
      childRequests: [childFirst(), childNext(EXTERNAL_FOUND_MESSAGE)],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'bad-header' })
  })
})

const EXTERNAL_PATH = DELEGATED_EXTERNAL_FIXTURE.hitPath
const EXTERNAL_HIT = `1. ${EXTERNAL_PATH}\n   Title: Zebra field notes\n   Snippet: The zebra flake appears when retries overlap.`
const EXTERNAL_FOUND_MESSAGE = `External sources for "zebra flake retry": 1 source, 1 hit.\n\n${DELEGATED_EXTERNAL_FIXTURE.sourceName} (project): /tmp/x/wiki\n\n${EXTERNAL_HIT}`
const EXTERNAL_NOT_ALLOWED =
  'External sources for "zebra flake retry": this project proposes 1 external source, but it is not in search.allow_project_sources, so nothing was read. To allow it, add "/tmp/x" to search.allow_project_sources in your user config.'

function externalPassing(): DelegatedSearchObservation {
  return {
    requestCount: 5,
    requestCap: DELEGATED_SEARCH_REQUEST_CAP,
    mode: EXTERNAL_DELEGATED_SEARCH_MODE,
    childRequests: [childFirst(), childNext(EXTERNAL_FOUND_MESSAGE)],
    parentRequests: [
      parentFirst(),
      parentFinal(`<task_result>CHILD-FOUND ${EXTERNAL_PATH}</task_result>`),
    ],
    parentAnswer: `${PARENT_FINAL_MARKER} ${EXTERNAL_PATH}`,
  }
}

describe('external mode', () => {
  test('the mode sets all four fields for external search', () => {
    expect(EXTERNAL_DELEGATED_SEARCH_MODE.headerPrefix).toBe(
      'External sources for "',
    )
    expect(EXTERNAL_DELEGATED_SEARCH_MODE.searchArguments).toEqual({
      query: 'zebra flake retry',
      kind: 'external',
    })
    expect(EXTERNAL_DELEGATED_SEARCH_MODE.expectedLabels).toEqual([
      { path: 'solution', labels: [] },
    ])
    expect(
      EXTERNAL_PATH.match(EXTERNAL_DELEGATED_SEARCH_MODE.pathPattern),
    ).toEqual([EXTERNAL_PATH])
    expect(
      EXTERNAL_PATH.startsWith(DELEGATED_EXTERNAL_FIXTURE.sourceName),
    ).toBe(true)
  })

  test('the external path pattern does not match a built-in doc path', () => {
    expect(PATH.match(EXTERNAL_DELEGATED_SEARCH_MODE.pathPattern)).toBe(null)
  })

  test('a delivered external hit and a parent answer naming its path pass', () => {
    expect(
      evaluateDelegatedSearchProof({
        ...externalPassing(),
        plantedPath: EXTERNAL_PATH,
      }),
    ).toEqual({ ok: true })
  })

  test('no Kind: or Status: label is required on the external hit', () => {
    expect(EXTERNAL_FOUND_MESSAGE).not.toContain('Kind:')
    expect(EXTERNAL_FOUND_MESSAGE).not.toContain('Status:')
    expect(
      evaluateDelegatedSearchProof({
        ...externalPassing(),
        plantedPath: EXTERNAL_PATH,
      }),
    ).toEqual({ ok: true })
  })

  test('a Search " header is not an external reply', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...externalPassing(),
      plantedPath: EXTERNAL_PATH,
      childRequests: [
        childFirst(),
        childNext(`Search "zebra": 1 doc, 1 hit.\n${EXTERNAL_HIT}`),
      ],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'bad-header' })
    if (!verdict.ok) {
      expect(verdict.message).toContain('External sources for "')
    }
  })

  test('the not-allowed reply fails with path-missing and names the allow list', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...externalPassing(),
      plantedPath: EXTERNAL_PATH,
      childRequests: [childFirst(), childNext(EXTERNAL_NOT_ALLOWED)],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'path-missing' })
    if (!verdict.ok) {
      expect(verdict.message).toContain('not in search.allow_project_sources')
    }
  })

  test('a path only quoted in a warning, not heading a hit, fails', () => {
    const quoted = `External sources for "zebra flake retry": 1 source, 0 hits.\nWarnings:\n- skipped ${EXTERNAL_PATH}\n\n${DELEGATED_EXTERNAL_FIXTURE.sourceName} (project): /tmp/x/wiki\n   No matching records.`
    const verdict = evaluateDelegatedSearchProof({
      ...externalPassing(),
      plantedPath: EXTERNAL_PATH,
      childRequests: [childFirst(), childNext(quoted)],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'bad-label' })
    if (!verdict.ok) expect(verdict.message).toContain('does not head a hit')
  })

  test('an Error: reply fails with error-result', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...externalPassing(),
      plantedPath: EXTERNAL_PATH,
      childRequests: [childFirst(), childNext('Error: search failed.')],
    })
    expect(verdict).toMatchObject({ ok: false, code: 'error-result' })
  })

  test('the planted built-in brainstorm path is not required in external mode', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...externalPassing(),
      plantedPath: EXTERNAL_PATH,
      plantedBrainstormPath: 'docs/brainstorms/unrelated.md',
    })
    expect(verdict).toEqual({ ok: true })
  })

  test('a final answer without the external path fails', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...externalPassing(),
      plantedPath: EXTERNAL_PATH,
      parentAnswer: `${PARENT_FINAL_MARKER} NO-PATH`,
    })
    expect(verdict).toMatchObject({
      ok: false,
      code: 'final-answer-missing-path',
    })
  })

  test('a mode with a label requirement still checks the hit heading', () => {
    const verdict = evaluateDelegatedSearchProof({
      ...externalPassing(),
      plantedPath: EXTERNAL_PATH,
      mode: {
        ...EXTERNAL_DELEGATED_SEARCH_MODE,
        expectedLabels: [{ path: 'solution', labels: ['node_type decision'] }],
      },
    })
    expect(verdict).toMatchObject({ ok: false, code: 'bad-label' })
  })

  test('the script calls the search tool with kind external and echoes the external path', () => {
    const s = createDelegatedSearchScript({
      dispatch: { tool: 'task', arguments: {} },
      isChildRequest: (r) => hasResearcherSystemMarker(r, MARKER),
      mode: EXTERNAL_DELEGATED_SEARCH_MODE,
    })
    s.respond(parentFirst())
    expect(s.respond(childFirst())).toEqual({
      toolCalls: [
        {
          id: 'delegated-search-call',
          name: SEARCH_TOOL,
          arguments: { query: 'zebra flake retry', kind: 'external' },
        },
      ],
    })
    expect(s.respond(childNext(EXTERNAL_FOUND_MESSAGE))).toEqual({
      text: `CHILD-FOUND ${EXTERNAL_PATH}`,
    })
    expect(
      s.respond(
        parentFinal(`<task_result>CHILD-FOUND ${EXTERNAL_PATH}</task_result>`),
      ),
    ).toEqual({ text: `PARENT-FINAL ${EXTERNAL_PATH}` })
    expect(s.observation().mode).toBe(EXTERNAL_DELEGATED_SEARCH_MODE)
  })

  test('the not-allowed reply makes the scripted child echo NO-PATH', () => {
    const s = createDelegatedSearchScript({
      dispatch: { tool: 'task', arguments: {} },
      isChildRequest: (r) => hasResearcherSystemMarker(r, MARKER),
      mode: EXTERNAL_DELEGATED_SEARCH_MODE,
    })
    expect(s.respond(childNext(EXTERNAL_NOT_ALLOWED))).toEqual({
      text: 'CHILD-FOUND NO-PATH',
    })
  })
})

describe('request readers and fixture', () => {
  const temp = createTempDirTracker()
  afterEach(() => temp.cleanup())

  test('the system text joins system and developer messages', () => {
    const text = systemTextOf({
      messages: [
        { role: 'developer', content: 'pi prompt' },
        { role: 'system', content: [{ type: 'text', text: 'other prompt' }] },
        { role: 'user', content: 'not system' },
      ],
    })
    expect(text).toContain('pi prompt')
    expect(text).toContain('other prompt')
    expect(text).not.toContain('not system')
  })

  test('the researcher marker is the first body line of the real agent file', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..')
    const marker = researcherSystemMarker(repoRoot)
    const raw = fs.readFileSync(
      path.join(repoRoot, DELEGATED_SEARCH_FIXTURE.researcherAgentFile),
      'utf8',
    )
    expect(marker.length).toBeGreaterThan(20)
    expect(raw).toContain(marker)
    expect(marker.startsWith('---')).toBe(false)
  })

  test('the marker skips frontmatter and blank lines', () => {
    const root = temp.track(
      fs.mkdtempSync(path.join(os.tmpdir(), 'delegated-proof-')),
    )
    const file = path.join(root, DELEGATED_SEARCH_FIXTURE.researcherAgentFile)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '---\nname: r\n---\n\n\nFirst body line.\nSecond.\n')
    expect(researcherSystemMarker(root)).toBe('First body line.')
  })

  test('an agent file with no body is an error', () => {
    const root = temp.track(
      fs.mkdtempSync(path.join(os.tmpdir(), 'delegated-proof-')),
    )
    const file = path.join(root, DELEGATED_SEARCH_FIXTURE.researcherAgentFile)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '---\nname: r\n---\n')
    expect(() => researcherSystemMarker(root)).toThrow('no body')
  })

  test('planting the external fixture writes the source folder and the proposing project file', () => {
    const root = temp.track(
      fs.mkdtempSync(path.join(os.tmpdir(), 'delegated-proof-')),
    )
    plantDelegatedExternalFixture(root)
    const note = fs.readFileSync(
      path.join(
        root,
        DELEGATED_EXTERNAL_FIXTURE.rootDir,
        DELEGATED_EXTERNAL_FIXTURE.fileName,
      ),
      'utf8',
    )
    expect(note).toContain('zebra flake')
    const config = JSON.parse(
      fs.readFileSync(path.join(root, '.opencode/systematic.jsonc'), 'utf8'),
    ) as { search: { sources: unknown[] } }
    expect(config.search.sources).toEqual([
      {
        name: DELEGATED_EXTERNAL_FIXTURE.sourceName,
        format: 'markdown',
        roots: [DELEGATED_EXTERNAL_FIXTURE.rootDir],
      },
    ])
    // A checkout root is what makes the project identity resolvable.
    expect(fs.existsSync(path.join(root, '.git'))).toBe(true)
  })

  test('planting writes the solution and the abandoned brainstorm', () => {
    const root = temp.track(
      fs.mkdtempSync(path.join(os.tmpdir(), 'delegated-proof-')),
    )
    plantDelegatedSearchFixture(root)
    expect(fs.readFileSync(path.join(root, PATH), 'utf8')).toContain(
      'zebra flake on retry',
    )
    const brainstorm = fs.readFileSync(
      path.join(root, DELEGATED_SEARCH_FIXTURE.brainstorm.path),
      'utf8',
    )
    expect(brainstorm).toContain('status: abandoned')
  })
})
