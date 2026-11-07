/**
 * A scripted model for one `ce:connect` rule family on a real Pi runtime.
 *
 * The parent delegates to `connections-researcher`. The researcher child then
 * runs the method the agent describes, in a fixed number of turns: it finds its
 * rule entries and the fingerprints of the files it will cite, reads them,
 * and answers with one batch. Every fingerprint and excerpt in the batch is
 * taken from a tool result the host actually returned to the child, so a read
 * that did not reach the child fails the script instead of being papered over.
 *
 * This shows that the plumbing lets a family finish inside the delegate's turn
 * cap. It does not show how many turns a live model needs.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  type ChatRequest,
  messageText,
  roleOf,
  systemTextOf,
} from './delegated-search-proof.js'

export interface ScriptedStep {
  text?: string
  toolCalls?: Array<{
    id: string
    name: string
    arguments: Record<string, unknown>
  }>
}

export interface FamilyFixture {
  readonly runId: string
  readonly family: string
  readonly rulesFile: string
  readonly filesIndex: string
  readonly ruleIds: readonly string[]
  /** The rule's own project and its learning. */
  readonly source: { readonly root: string; readonly path: string }
  /** The project that should change and its learning. */
  readonly target: { readonly root: string; readonly path: string }
  /** A sentence that appears in each learning's guidance, copied into an excerpt. */
  readonly sourceSentence: string
  readonly targetSentence: string
}

/** The first line of the researcher's agent body, which is in its system prompt and the parent's never is. */
export function connectResearcherMarker(repoRoot: string): string {
  const raw = fs.readFileSync(
    path.join(repoRoot, 'agents/research/connections-researcher.md'),
    'utf8',
  )
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '')
  const line = body.split('\n').find((candidate) => candidate.trim() !== '')
  if (line === undefined) throw new Error('researcher agent file has no body')
  return line.slice(0, 80)
}

/** The dispatch block the skill sends, filled from the fixture. */
export function dispatchBlock(
  fixture: FamilyFixture,
  names: Readonly<Record<string, string>>,
): string {
  return [
    `run: ${fixture.runId}`,
    `family: ${fixture.family}`,
    `rules file: ${fixture.rulesFile}`,
    `files index: ${fixture.filesIndex}`,
    'projects:',
    ...Object.entries(names).map(([root, name]) => `- ${root} (${name})`),
    `rule ids: ${fixture.ruleIds.join(', ')}`,
    'max candidates: 5',
  ].join('\n')
}

function toolResultsText(request: ChatRequest): string {
  return (request.messages ?? [])
    .filter((message) => roleOf(message) === 'tool')
    .map((message) => messageText(message))
    .join('\n')
}

/** Turns the child has taken so far: one assistant message each. */
export function childTurnsSoFar(request: ChatRequest): number {
  return (request.messages ?? []).filter(
    (message) => roleOf(message) === 'assistant',
  ).length
}

function fingerprintFor(results: string, root: string, rel: string): string {
  const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = new RegExp(
    `([0-9a-f]{64})\\s+learning\\s+${escaped(root)}\\s+${escaped(rel)}`,
  ).exec(results)
  if (found?.[1] === undefined) {
    throw new Error(
      `the files index did not reach the child with a line for ${rel}`,
    )
  }
  return found[1]
}

function requireText(results: string, text: string): string {
  if (!results.includes(text)) {
    throw new Error(`a read did not reach the child with: ${text}`)
  }
  return text
}

export function batchFromResults(
  fixture: FamilyFixture,
  results: string,
): string {
  const sourceFingerprint = fingerprintFor(
    results,
    fixture.source.root,
    fixture.source.path,
  )
  const targetFingerprint = fingerprintFor(
    results,
    fixture.target.root,
    fixture.target.path,
  )
  return JSON.stringify({
    version: 1,
    runId: fixture.runId,
    family: fixture.family,
    ruleIds: [...fixture.ruleIds],
    projects: [fixture.source.root, fixture.target.root],
    files: [fixture.source.path, fixture.target.path],
    searches: ['"id": "<rule id>"', 'retry'],
    complete: true,
    candidates: [
      {
        kind: 'contradiction',
        ruleId: fixture.ruleIds[0],
        target: fixture.target.root,
        title:
          'Retrying queue writes is required in one project and forbidden in another',
        summary:
          'One learning says to retry failed queue writes and the other says never to, for the same queue API.',
        nextStep: 'investigate',
        overlapCheck: {
          queries: ['retry queue write'],
          result: 'none-found',
        },
        sources: [
          {
            project: fixture.source.root,
            path: fixture.source.path,
            fingerprint: sourceFingerprint,
            excerpt: requireText(results, fixture.sourceSentence),
          },
          {
            project: fixture.target.root,
            path: fixture.target.path,
            fingerprint: targetFingerprint,
            excerpt: requireText(results, fixture.targetSentence),
          },
        ],
        targetEvidence: [],
        counterevidence: [],
      },
    ],
  })
}

export interface FamilyObservation {
  readonly childRequests: ChatRequest[]
  readonly childToolNames: string[]
}

export interface FamilyScript {
  respond(request: ChatRequest): ScriptedStep
  observation(): FamilyObservation
}

export interface FamilyScriptOptions {
  readonly fixture: FamilyFixture
  readonly dispatch: string
  readonly marker: string
  /** The child never answers: it asks for another read every turn. */
  readonly neverAnswers?: boolean
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A responder for the parent and the child, told apart by the child's system prompt. */
export function createFamilyScript(options: FamilyScriptOptions): FamilyScript {
  const { fixture, marker } = options
  const childRequests: ChatRequest[] = []
  const toolNames = new Set<string>()
  let parentCalls = 0

  const childStep = (request: ChatRequest): ScriptedStep => {
    const turn = childTurnsSoFar(request)
    if (options.neverAnswers === true) {
      return {
        toolCalls: [
          {
            id: `call_loop_${turn}`,
            name: 'read',
            arguments: { path: fixture.rulesFile, offset: 1, limit: 5 },
          },
        ],
      }
    }
    if (turn === 0) {
      // One turn: find the rule entries and the fingerprint lines together.
      const ids = fixture.ruleIds
        .map((id) => `"id": "${escapeForPattern(id)}"`)
        .join('|')
      return {
        toolCalls: [
          {
            id: 'call_rules',
            name: 'grep',
            arguments: { pattern: ids, path: fixture.rulesFile },
          },
          {
            id: 'call_fp_source',
            name: 'grep',
            arguments: {
              pattern: escapeForPattern(fixture.source.path),
              path: fixture.filesIndex,
            },
          },
          {
            id: 'call_fp_target',
            name: 'grep',
            arguments: {
              pattern: escapeForPattern(fixture.target.path),
              path: fixture.filesIndex,
            },
          },
        ],
      }
    }
    if (turn === 1) {
      // One turn: read the rule entries, and search the target for the failure shape.
      return {
        toolCalls: [
          {
            id: 'call_read_rules',
            name: 'read',
            arguments: { path: fixture.rulesFile, offset: 1, limit: 120 },
          },
          {
            id: 'call_read_source',
            name: 'read',
            arguments: {
              path: path.join(fixture.source.root, fixture.source.path),
            },
          },
          {
            id: 'call_read_target',
            name: 'read',
            arguments: {
              path: path.join(fixture.target.root, fixture.target.path),
            },
          },
          {
            id: 'call_search_target',
            name: 'grep',
            arguments: {
              pattern: 'retry',
              path: path.join(fixture.target.root, 'docs/solutions'),
            },
          },
        ],
      }
    }
    return { text: batchFromResults(fixture, toolResultsText(request)) }
  }

  return {
    respond(request) {
      if (systemTextOf(request).includes(marker)) {
        childRequests.push(request)
        for (const name of (request.tools ?? []).map(
          (tool) =>
            (tool as { function?: { name?: unknown } } | null)?.function?.name,
        )) {
          if (typeof name === 'string') toolNames.add(name)
        }
        return childStep(request)
      }
      parentCalls += 1
      if (parentCalls === 1) {
        return {
          toolCalls: [
            {
              id: 'call_delegate_family',
              name: 'systematic_delegate',
              arguments: {
                agent: 'connections-researcher',
                task: options.dispatch,
              },
            },
          ],
        }
      }
      return { text: 'family done' }
    },
    observation: () => ({
      childRequests,
      childToolNames: [...toolNames].sort(),
    }),
  }
}
