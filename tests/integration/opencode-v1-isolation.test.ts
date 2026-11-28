// Tool isolation for the shipped connections-researcher on the current
// OpenCode v1 pin. The agent under test is the file the packed plugin ships.
// A scripted child tries shell, write, edit and web fetch and then reads a
// planted note; the proof reads the tool results, the disk and a fetch server.
// A control on a copy without the deny entries must fail by name.
//
// What this does not show: a live model's choices, path scoping of the read
// tools (the researcher can open any file the user can), or the tools of MCP
// servers in the session. The scripted model makes every call, so the proof
// shows what the host enforces.
//
// This file runs on the current v1 pin only. The v1 floor is not a host this
// behavior is claimed for, so the floor profile does not list it.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { requireOpencodeAvailable } from '../../scripts/lib/opencode-availability.js'
import {
  agentSystemMarker,
  CONNECT_AGENT,
  type ConnectIsolationScript,
  connectIsolationLayout,
  connectObservation,
  createConnectIsolationScript,
  evaluateConnectIsolationProof,
  type IsolationHostTools,
  plantConnectExternalCheckout,
  plantConnectIsolationFixture,
  readConnectSideEffects,
  readShippedDefinition,
  resolveRunDefinition,
  startFetchCounter,
  withoutDenyEntries,
  withoutExternalDirectoryAllow,
} from '../helpers/connect-delegated-proof.js'
import {
  type ChatRequest,
  hasResearcherSystemMarker,
  toolNamesOf,
} from '../helpers/delegated-search-proof.js'
import {
  CONTROL_AGENT,
  controlOfferFailures,
  ENV_FILE_MARKER,
  EXTERNAL_NOTE_MARKER,
  externalReadFailures,
  hostShellDenyConfig,
  REVIEWER_AGENT,
  readOutcome,
  readParityFailures,
  reviewerOfferFailures,
  runReviewerOffer,
  shippedAgentMarker,
  THROWAWAY_AGENT,
  THROWAWAY_MARKER,
  throwawayAgentConfig,
} from '../helpers/reviewer-tools-proof.js'
import {
  buildIsolatedOpencodeEnv,
  buildOpencodeRunArgv,
  cleanupPackedTarball,
  createIsolatedFixture,
  destroyIsolatedFixture,
  extractPackagedPlugin,
  getOpencodeAvailability,
  type IsolatedFixture,
  isOpencodeAvailable,
  type OpencodeResult,
  opencodeAvailabilityReason,
  packTarballOnce,
  type ScriptedModelServer,
  scriptedResponseChunks,
  spawnOpencodeChild,
  TIMEOUT_MS,
  withScriptedProvider,
} from './fixtures/opencode-host.js'

const HOST = 'v1'

requireOpencodeAvailable(getOpencodeAvailability(HOST))
if (!isOpencodeAvailable(HOST)) {
  console.warn(
    `[systematic] skipping OpenCode v1 isolation tests in opencode-v1-isolation.test.ts: ${opencodeAvailabilityReason(HOST)}`,
  )
}

const V1_ISOLATION_TOOLS: IsolationHostTools = {
  shell: 'bash',
  write: 'write',
  edit: 'edit',
  webfetch: 'webfetch',
  read: 'read',
}

/** A scripted model that answers every request from the isolation script. */
function startIsolationModel(
  script: Pick<ConnectIsolationScript, 'respond'>,
): ScriptedModelServer {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        !request.url.endsWith('/chat/completions')
      ) {
        return new Response('not found', { status: 404 })
      }
      const body = (await request.json()) as ChatRequest
      const chunks = scriptedResponseChunks(
        script.respond(body),
        'v1-connect-isolation-response',
        Math.floor(Date.now() / 1000),
      )
      const sse = [
        ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
        'data: [DONE]\n\n',
      ].join('')
      return new Response(new TextEncoder().encode(sse), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

describe.skipIf(!isOpencodeAvailable(HOST) || process.platform === 'win32')(
  'researcher tool isolation on the current OpenCode v1 pin',
  () => {
    let fixture: IsolatedFixture

    beforeAll(() => {
      packTarballOnce()
    }, 200_000)

    afterAll(() => {
      cleanupPackedTarball()
    })

    beforeEach(() => {
      fixture = createIsolatedFixture()
    })

    afterEach(() => {
      destroyIsolatedFixture(fixture)
    })

    /**
     * Runs the parent through `opencode run`, with the scripted parent
     * dispatching the researcher by `task`. Without `definition` the agent is
     * the one the packed plugin ships; with one, that text replaces it, which
     * is how a control runs a changed copy. `hostPermission` is the user's own
     * top-level permission block, which is where a blanket allow lives on v1.
     */
    async function runConnectIsolation(options: {
      definition?: string
      hostPermission?: Record<string, string>
      /** Read a note in a git checkout outside the project instead of one inside it. */
      external?: boolean
    }): Promise<{
      result: OpencodeResult
      script: ConnectIsolationScript
      marker: string
      /** The agent definition as the extracted package carried it before any replacement. */
      packaged: string | undefined
      sideEffects: ReturnType<typeof readConnectSideEffects>
    }> {
      const { packageDir, pluginUrl } = extractPackagedPlugin(fixture, HOST)
      const { definition, packaged } = resolveRunDefinition(
        packageDir,
        options.definition,
      )
      // The host resolves its working directory to a real path, and a path under
      // a symlinked temp directory would read as outside the project.
      const projectLayout = connectIsolationLayout(
        fs.realpathSync(fixture.projectDir),
      )
      plantConnectIsolationFixture(projectLayout)
      const layout = options.external
        ? plantConnectExternalCheckout(
            projectLayout,
            path.join(fs.realpathSync(fixture.tempRoot), 'external-checkout'),
          )
        : projectLayout
      const fetchCounter = startFetchCounter()
      const marker = agentSystemMarker(definition)
      const script = createConnectIsolationScript({
        layout,
        hostTools: V1_ISOLATION_TOOLS,
        fetchUrl: fetchCounter.url,
        dispatch: {
          tool: 'task',
          arguments: {
            description: 'Read the probe note',
            prompt: 'Read the probe note and report its marker.',
            subagent_type: CONNECT_AGENT,
          },
        },
        isChildRequest: (request) => hasResearcherSystemMarker(request, marker),
      })
      const model = startIsolationModel(script)
      try {
        const configContent = withScriptedProvider(
          JSON.stringify({
            plugin: [pluginUrl],
            snapshot: false,
            ...(options.hostPermission !== undefined && {
              permission: options.hostPermission,
            }),
          }),
          model.url,
          HOST,
        )
        const result = await spawnOpencodeChild(
          buildOpencodeRunArgv(
            HOST,
            'Dispatch the researcher to read the probe note.',
          ),
          {
            cwd: fixture.projectDir,
            env: buildIsolatedOpencodeEnv(
              fixture,
              configContent,
              undefined,
              HOST,
            ),
            timeoutMs: TIMEOUT_MS,
          },
        )
        return {
          result,
          script,
          marker,
          packaged,
          sideEffects: readConnectSideEffects(layout, fetchCounter.hits()),
        }
      } finally {
        model.stop()
        fetchCounter.stop()
      }
    }

    test(
      'the shipped researcher, dispatched from the packed plugin, is refused shell, write, edit and web fetch and its read reaches the parent',
      async () => {
        const run = await runConnectIsolation({})

        // The agent that ran is the committed file, not a fixture.
        expect(run.packaged).toBe(readShippedDefinition())
        expect(run.result.exitCode).toBe(0)
        // `opencode run` prints the parent's final message and nothing else on
        // stdout, so stdout is that one message.
        const verdict = evaluateConnectIsolationProof(
          connectObservation(
            run.script,
            run.sideEffects,
            run.result.stdout.trim(),
          ),
        )
        expect(verdict).toEqual({ ok: true })
        expect(run.sideEffects).toEqual({
          writtenPaths: [],
          editTargetChanged: false,
          fetchHits: 0,
          extraWorktrees: 0,
        })
        // The child that ran is the researcher, not some other agent.
        for (const child of run.script.observation().childRequests) {
          expect(hasResearcherSystemMarker(child, run.marker)).toBe(true)
        }
        // The refusals are real denials: the parent is offered each tool the
        // child lacks, so none of the names is a typo.
        const parentOffered = toolNamesOf(
          run.script.observation().parentRequests[0] ?? {},
        )
        const childOffered = toolNamesOf(
          run.script.observation().childRequests[0] ?? {},
        )
        for (const denied of ['bash', 'write', 'edit', 'webfetch', 'task']) {
          expect(parentOffered, `parent is offered ${denied}`).toContain(denied)
          expect(childOffered, `child is offered ${denied}`).not.toContain(
            denied,
          )
        }
      },
      TIMEOUT_MS * 2,
    )

    test(
      'with the deny entries removed the same script writes a file and the proof names an isolation breach',
      async () => {
        const run = await runConnectIsolation({
          definition: withoutDenyEntries(readShippedDefinition()),
        })

        expect(run.result.exitCode).toBe(0)
        const verdict = evaluateConnectIsolationProof(
          connectObservation(
            run.script,
            run.sideEffects,
            run.result.stdout.trim(),
          ),
        )
        expect(verdict).toMatchObject({ ok: false, code: 'isolation-breach' })
        // The child was reached, so the failure is the missing deny entries and
        // not a dispatch that never happened.
        expect(run.script.observation().childRequests.length).toBeGreaterThan(0)
        expect(run.sideEffects.writtenPaths.length).toBeGreaterThan(0)
      },
      TIMEOUT_MS * 2,
    )

    test(
      "a blanket allow in the host's own permission block does not lift the shipped researcher's deny",
      async () => {
        const run = await runConnectIsolation({
          hostPermission: {
            '*': 'allow',
            bash: 'allow',
            edit: 'allow',
            webfetch: 'allow',
          },
        })

        expect(run.result.exitCode).toBe(0)
        const verdict = evaluateConnectIsolationProof(
          connectObservation(
            run.script,
            run.sideEffects,
            run.result.stdout.trim(),
          ),
        )
        expect(verdict).toEqual({ ok: true })
        expect(fs.existsSync(path.join(fixture.projectDir, 'isolation'))).toBe(
          true,
        )
      },
      TIMEOUT_MS * 2,
    )

    // Reading another project's checkout is the researcher's whole job, and a
    // checkout outside the working directory is "external" to the host. The
    // definition's `external_directory: allow` is what lets the read through;
    // everything else stays denied.
    test(
      'a headless run reads a git checkout outside the project and the marker reaches the parent, with every denied tool still refused',
      async () => {
        const run = await runConnectIsolation({ external: true })

        expect(run.result.exitCode).toBe(0)
        expect(run.result.stderr).not.toMatch(/permission requested/)
        const verdict = evaluateConnectIsolationProof(
          connectObservation(
            run.script,
            run.sideEffects,
            run.result.stdout.trim(),
          ),
        )
        expect(verdict).toEqual({ ok: true })
        expect(run.result.stdout).toContain('CONNECT-PROBE-MARKER')
        expect(run.sideEffects).toEqual({
          writtenPaths: [],
          editTargetChanged: false,
          fetchHits: 0,
          extraWorktrees: 0,
        })
        const childOffered = toolNamesOf(
          run.script.observation().childRequests[0] ?? {},
        )
        for (const denied of ['bash', 'write', 'edit', 'webfetch', 'task']) {
          expect(childOffered, `child is offered ${denied}`).not.toContain(
            denied,
          )
        }
      },
      TIMEOUT_MS * 2,
    )

    test(
      'without external_directory: allow the same read is auto-rejected, which pins what the entry does',
      async () => {
        const run = await runConnectIsolation({
          definition: withoutExternalDirectoryAllow(readShippedDefinition()),
          external: true,
        })

        expect(run.result.exitCode).toBe(0)
        expect(run.result.stderr).toMatch(
          /permission requested: external_directory .*auto-rejecting/,
        )
        const verdict = evaluateConnectIsolationProof(
          connectObservation(
            run.script,
            run.sideEffects,
            run.result.stdout.trim(),
          ),
        )
        expect(verdict).toMatchObject({ ok: false })
        expect(run.result.stdout).not.toContain('CONNECT-PROBE-MARKER')
      },
      TIMEOUT_MS * 2,
    )

    // The review agents ship a deny list: it names the tools a reviewer should
    // not have and sets nothing for `read`, `bash` or `external_directory`, so
    // the user's own rules and the host's defaults still decide those. The
    // reviewer tests compare a reviewer child with a control child of an agent
    // that has no permission block. The throwaway agent tests write a
    // permission map straight into the host config.
    describe('a dispatched review agent', () => {
      const ALLOW_FOUR = [
        ['read', 'allow'],
        ['grep', 'allow'],
        ['glob', 'allow'],
        ['bash', 'allow'],
      ] as const

      /** What the parent has that the child must lack, so a denial is never a typo. */
      const PARENT_ONLY = [
        'task',
        'systematic_skill',
        'skill',
        'write',
        'edit',
        'systematic_search',
        'webfetch',
      ]

      function dispatch(
        agent: string,
        options: Partial<Parameters<typeof runReviewerOffer>[2]> = {},
      ) {
        return runReviewerOffer(HOST, fixture, {
          agent,
          marker: shippedAgentMarker(agent),
          ...options,
        })
      }

      /** Runs the reviewer, then the control agent, each in a fresh fixture. */
      async function reviewerAndControl(
        options: Partial<Parameters<typeof runReviewerOffer>[2]> = {},
      ) {
        const reviewer = await dispatch(REVIEWER_AGENT, options)
        destroyIsolatedFixture(fixture)
        fixture = createIsolatedFixture()
        const control = await dispatch(CONTROL_AGENT, options)
        return { reviewer, control }
      }

      test(
        'is offered what a control agent is, less the withheld tools',
        async () => {
          const { reviewer, control } = await reviewerAndControl()

          expect(reviewer.exitCode).toBe(0)
          expect(control.exitCode).toBe(0)
          expect(reviewerOfferFailures(HOST, reviewer, control)).toEqual([])
        },
        TIMEOUT_MS * 3,
      )

      test(
        'reads a file outside the project as a control agent does',
        async () => {
          const { reviewer, control } = await reviewerAndControl()

          expect(reviewer.exitCode).toBe(0)
          expect(
            readParityFailures(reviewer, control, EXTERNAL_NOTE_MARKER),
          ).toEqual([])
          if (!readOutcome(control, EXTERNAL_NOTE_MARKER).returned) {
            expect(readOutcome(reviewer, EXTERNAL_NOTE_MARKER).returned).toBe(
              false,
            )
          }
        },
        TIMEOUT_MS * 3,
      )

      test(
        'reads a project .env file as a control agent does',
        async () => {
          const { reviewer, control } = await reviewerAndControl({
            childRead: 'project-env',
          })

          expect(reviewer.exitCode).toBe(0)
          expect(
            readParityFailures(reviewer, control, ENV_FILE_MARKER),
          ).toEqual([])
          if (!readOutcome(control, ENV_FILE_MARKER).returned) {
            expect(readOutcome(reviewer, ENV_FILE_MARKER).returned).toBe(false)
          }
        },
        TIMEOUT_MS * 3,
      )

      test(
        "under the user's host-wide shell deny, neither the reviewer nor a control agent is offered the shell tool",
        async () => {
          const { reviewer, control } = await reviewerAndControl({
            hostConfig: hostShellDenyConfig(HOST),
          })

          expect(reviewer.exitCode).toBe(0)
          expect(reviewer.childIsAgent).toBe(true)
          expect(control.childIsAgent).toBe(true)
          expect(reviewer.parentOffered).not.toContain('bash')
          expect(reviewer.childOffered).toContain('read')
          expect(reviewer.childOffered).not.toContain('bash')
          expect(control.childOffered).toContain('read')
          expect(control.childOffered).not.toContain('bash')
        },
        TIMEOUT_MS * 3,
      )

      test(
        'under a user overlay of bash: deny is not offered the shell tool',
        async () => {
          const run = await dispatch(REVIEWER_AGENT, {
            systematicConfig: {
              agents: { [REVIEWER_AGENT]: { permission: { bash: 'deny' } } },
            },
          })

          expect(run.exitCode).toBe(0)
          expect(run.childIsAgent).toBe(true)
          expect(run.parentOffered).toContain('bash')
          expect(run.childOffered).toContain('read')
          expect(run.childOffered).not.toContain('bash')
        },
        TIMEOUT_MS * 2,
      )

      test(
        'under a user overlay of systematic_skill: allow is offered that tool again',
        async () => {
          const run = await dispatch(REVIEWER_AGENT, {
            systematicConfig: {
              agents: {
                [REVIEWER_AGENT]: { permission: { systematic_skill: 'allow' } },
              },
            },
          })

          expect(run.exitCode).toBe(0)
          expect(run.childIsAgent).toBe(true)
          expect(run.parentOffered).toContain('systematic_skill')
          expect(run.childOffered).toContain('systematic_skill')
          expect(run.childOffered).not.toContain('write')
        },
        TIMEOUT_MS * 2,
      )

      test(
        'a control agent with no permission block is offered what the parent is, less what the host takes from every child',
        async () => {
          const run = await runReviewerOffer(HOST, fixture, {
            agent: CONTROL_AGENT,
            marker: shippedAgentMarker(CONTROL_AGENT),
          })

          expect(run.exitCode).toBe(0)
          expect(controlOfferFailures(HOST, run)).toEqual([])
          expect(run.childOffered).toEqual(
            expect.arrayContaining([
              'read',
              'bash',
              'write',
              'systematic_skill',
            ]),
          )
        },
        TIMEOUT_MS * 2,
      )

      test.each(['bare', 'rule-map'] as const)(
        "a throwaway agent whose permission map starts with '*': deny, written as a %s map, is offered only the allowed tools",
        async (form) => {
          const run = await runReviewerOffer(HOST, fixture, {
            agent: THROWAWAY_AGENT,
            marker: THROWAWAY_MARKER,
            hostConfig: throwawayAgentConfig(HOST, {
              entries: [['*', 'deny'], ...ALLOW_FOUR],
              v1Form: form,
            }),
          })

          expect(run.exitCode).toBe(0)
          expect(run.childIsAgent).toBe(true)
          for (const name of PARENT_ONLY) {
            expect(run.parentOffered, `parent is offered ${name}`).toContain(
              name,
            )
          }
          expect([...run.childOffered].sort()).toEqual([
            'bash',
            'glob',
            'grep',
            'read',
          ])
        },
        TIMEOUT_MS * 2,
      )

      test(
        'allows after a leading deny bring back a web fetch and a plugin tool',
        async () => {
          const run = await runReviewerOffer(HOST, fixture, {
            agent: THROWAWAY_AGENT,
            marker: THROWAWAY_MARKER,
            hostConfig: throwawayAgentConfig(HOST, {
              entries: [
                ['*', 'deny'],
                ...ALLOW_FOUR,
                ['webfetch', 'allow'],
                ['systematic_search', 'allow'],
              ],
            }),
          })

          expect(run.childIsAgent).toBe(true)
          expect([...run.childOffered].sort()).toEqual([
            'bash',
            'glob',
            'grep',
            'read',
            'systematic_search',
            'webfetch',
          ])
        },
        TIMEOUT_MS * 2,
      )

      test(
        "a leading '*': deny also denies a read outside the project, and an external_directory: allow line permits it",
        async () => {
          const denied = await runReviewerOffer(HOST, fixture, {
            agent: THROWAWAY_AGENT,
            marker: THROWAWAY_MARKER,
            hostConfig: throwawayAgentConfig(HOST, {
              entries: [['*', 'deny'], ...ALLOW_FOUR],
            }),
          })
          expect(denied.stderr).not.toMatch(/permission requested/)
          expect(denied.childCallResult).toContain(
            'prevents you from using this specific tool call',
          )
          expect(denied.childCallResult).not.toContain(EXTERNAL_NOTE_MARKER)

          destroyIsolatedFixture(fixture)
          fixture = createIsolatedFixture()
          const allowed = await runReviewerOffer(HOST, fixture, {
            agent: THROWAWAY_AGENT,
            marker: THROWAWAY_MARKER,
            hostConfig: throwawayAgentConfig(HOST, {
              entries: [
                ['*', 'deny'],
                ...ALLOW_FOUR,
                ['external_directory', 'allow'],
              ],
            }),
          })
          expect(externalReadFailures(allowed)).toEqual([])
        },
        TIMEOUT_MS * 3,
      )
    })
  },
)
