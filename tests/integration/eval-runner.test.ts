import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  type BoundedProbeEvent,
  createOpencodeProbe,
  gradeBootstrapProbe,
  gradeFixtureWrite,
  gradeHostSkillCoverage,
  observePromptComposition,
} from '../../scripts/eval-cases/opencode.ts'
import {
  type OpencodeAvailabilityClassification,
  probeOpencodeAvailability,
  requireOpencodeAvailable,
  resolveBunInstallCacheDir,
} from '../../scripts/lib/opencode-availability.ts'
import {
  type CaseId,
  capturePrimaryCheckout,
  cleanupEvalFixture,
  createEvalFixture,
  type EvalFixture,
  type EvalSelectionRunnerInput,
  type EvalSubcode,
  EXPECTED_OPENCODE_VERSION,
  installEvalSignalHandlers,
  normalizeResult,
  persistEvalRun,
  runEvalCli,
  runEvalSelections,
  runInstalledEval,
  runSourceEval,
  validateSerializedResult,
  validateSerializedRunManifest,
} from '../../scripts/run-evals.ts'
import { buildCatalogEntries } from '../../src/lib/skill-catalog.js'

// This module has no fixture at module scope (unlike the five suites built on
// tests/integration/fixtures/receipt-workflow-host.ts), so it computes its own
// availability gate once here: a minimal explicit env (parent PATH/HOME/XDG,
// a throwaway TMPDIR, and the shared BUN_INSTALL_CACHE_DIR so the gate shares
// one bunx download rather than paying its own), removed afterwards. Never at
// the fixture module's scope, so `bun test tests/unit` never spawns `bunx`.
function computeOpencodeAvailability(): OpencodeAvailabilityClassification {
  const probeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'systematic-eval-runner-probe-'),
  )
  try {
    return probeOpencodeAvailability({
      pin: EXPECTED_OPENCODE_VERSION,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: probeRoot,
        XDG_CONFIG_HOME: probeRoot,
        XDG_DATA_HOME: probeRoot,
        XDG_CACHE_HOME: probeRoot,
        XDG_STATE_HOME: probeRoot,
        TMPDIR: probeRoot,
        // Mirrors buildEvalChildEnv's real-host env so a first-run
        // autoupdate/models fetch can't pollute the probe's stdout or add
        // network latency the real hosts don't pay.
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_PRUNE: '1',
        BUN_INSTALL_CACHE_DIR: resolveBunInstallCacheDir({
          pin: EXPECTED_OPENCODE_VERSION,
        }),
      },
    })
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true })
  }
}

const OPENCODE_AVAILABILITY = computeOpencodeAvailability()
requireOpencodeAvailable(OPENCODE_AVAILABILITY)
const OPENCODE_AVAILABLE = OPENCODE_AVAILABILITY.status === 'available'
if (!OPENCODE_AVAILABLE) {
  console.warn(
    `[systematic] skipping OpenCode-dependent tests in eval-runner.test.ts: ${OPENCODE_AVAILABILITY.reason}`,
  )
}

const FIXED_CLOCK = '2026-08-13T00:00:00.000Z'
const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const EXPECTED_CLI_HELP = [
  'Usage: bun scripts/run-evals.ts [options]',
  '',
  'Options:',
  '  --case <id>       Repeatable: bootstrap-loading | fixture-local-write | host-skill-coverage | model-inheritance',
  '  --mode <mode>     Repeatable: source | installed',
  '  --seed <seed>     [A-Za-z0-9][A-Za-z0-9._-]{0,127}',
  '  --clock <UTC>     YYYY-MM-DDTHH:mm:ss.sssZ',
  '  --help            Show this help',
  '',
  'Output: evals/runs/<runId>/; manifest.json is the final completion marker.',
  'Exit codes: 0 success; 1 completed or partial run with a non-success outcome; 2 invalid arguments.',
].join('\n')

function syntheticExecution(
  outcome: 'success' | 'task_failure' | 'infra_failure',
  subcode:
    | 'none'
    | 'write_mismatch'
    | 'unexpected_exit'
    | 'identity_drift'
    | 'artifact_resolution',
): {
  outcome: 'success' | 'task_failure' | 'infra_failure'
  subcode:
    | 'none'
    | 'write_mismatch'
    | 'unexpected_exit'
    | 'identity_drift'
    | 'artifact_resolution'
  sanity: 'passed' | 'failed'
  process: 'completed' | 'failed'
  probeDigest: string
  artifactRefs: string[]
} {
  return {
    outcome,
    subcode,
    sanity: outcome === 'success' ? 'passed' : 'failed',
    process: outcome === 'success' ? 'completed' : 'failed',
    probeDigest: 'a'.repeat(64),
    artifactRefs: ['probe/events.jsonl'],
  }
}

const SYNTHETIC_CASE_ASSERTIONS = {
  'bootstrap-loading': ['bootstrap-observed'],
  'fixture-local-write': ['fixture-file-content', 'fixture-file-created'],
  'host-skill-coverage': ['host-catalog-covered'],
  'model-inheritance': [
    'agents-inherit-invoking-model',
    'explicit-model-overlay-wins',
    'model-null-restores-inheritance',
    'project-model-trust-boundary',
  ],
} as const satisfies Record<CaseId, readonly string[]>

// Does not build the 'model-inheritance' evidence branch; passing that
// caseId throws in normalizeEvidence.
function syntheticResult(options: {
  caseId: CaseId
  mode: 'source' | 'installed'
  runId: string
  outcome: 'success' | 'task_failure' | 'infra_failure'
  subcode: 'none' | 'write_mismatch' | 'identity_drift' | 'artifact_resolution'
}): ReturnType<typeof normalizeResult> {
  const installed = options.mode === 'installed'
  const assertionIds = SYNTHETIC_CASE_ASSERTIONS[options.caseId]
  return normalizeResult({
    resultSchemaVersion: 1,
    caseSchemaVersion: 1,
    caseId: options.caseId,
    harness: 'opencode',
    mode: options.mode,
    outcome: options.outcome,
    subcode: options.subcode,
    runId: options.runId,
    fixtureSeed: 'synthetic-seed',
    normalizedClock: FIXED_CLOCK,
    assertionIds,
    identity: {
      opencodeVersion: EXPECTED_OPENCODE_VERSION,
      opencodeBuildId: `opencode-ai-${EXPECTED_OPENCODE_VERSION}`,
      probeId: 'probe-opencode-v1',
      probeDigest: 'a'.repeat(64),
      fixtureContractVersion: 1,
      fixtureContractDigest: 'b'.repeat(64),
      caseSchemaVersion: 1,
      resultSchemaVersion: 1,
      artifactId: installed ? 'installed-entry' : 'source-entry',
      artifactDigest: 'c'.repeat(64),
    },
    evidence: {
      sanity: options.outcome === 'success' ? 'passed' : 'failed',
      process: options.outcome === 'success' ? 'completed' : 'failed',
      assertionIds,
    },
    cleanup: { status: 'clean', residue: 'none' },
    privacy: { status: 'validated' },
    artifactRefs: ['probe/events.jsonl'],
    provenance: installed
      ? {
          kind: 'installed',
          packageName: '@fro.bot/systematic',
          packageVersion: '1.2.3',
          tarballDigest: 'd'.repeat(64),
          extractedPackageRootId: 'installed-package-root',
          canonicalResolvedModuleEntryId: 'dist/index.js',
          opencodeConfigEntryId: 'installed-config',
        }
      : {
          kind: 'source',
          checkoutRelativeSource: 'src/index.ts',
          commitId: 'e'.repeat(40),
          worktreeId: 'synthetic-worktree',
          canonicalSourceEntryId: 'source-entry',
          opencodeConfigEntryId: 'source-config',
        },
  })
}

function runParent(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-eval-runner-test-'))
}

function expectRuntimeOutcome(
  result: ReturnType<typeof normalizeResult>,
): void {
  expect(result.outcome).toBe('success')
  expect(result.identity.opencodeVersion).toBe(EXPECTED_OPENCODE_VERSION)
  expect(result.identity.opencodeBuildId).toBe(
    `opencode-ai-${EXPECTED_OPENCODE_VERSION}`,
  )
}

function boundedInfraResult(): ReturnType<typeof normalizeResult> {
  return normalizeResult({
    resultSchemaVersion: 1,
    caseSchemaVersion: 1,
    caseId: 'bootstrap-loading',
    harness: 'opencode',
    mode: 'source',
    outcome: 'infra_failure',
    subcode: 'opencode_unavailable',
    runId: 'run-infra',
    fixtureSeed: 'fixture-infra',
    normalizedClock: FIXED_CLOCK,
    assertionIds: ['bootstrap-observed'],
    identity: {
      opencodeVersion: EXPECTED_OPENCODE_VERSION,
      opencodeBuildId: `opencode-ai-${EXPECTED_OPENCODE_VERSION}`,
      probeId: 'probe-opencode-v1',
      probeDigest: 'a'.repeat(64),
      fixtureContractVersion: 1,
      fixtureContractDigest: 'b'.repeat(64),
      caseSchemaVersion: 1,
      resultSchemaVersion: 1,
      artifactId: 'source-entry',
      artifactDigest: 'c'.repeat(64),
    },
    evidence: {
      sanity: 'failed',
      process: 'failed',
      assertionIds: ['bootstrap-observed'],
    },
    cleanup: { status: 'clean', residue: 'none' },
    privacy: { status: 'validated' },
    artifactRefs: ['probe/events.jsonl'],
    provenance: {
      kind: 'source',
      checkoutRelativeSource: 'src/index.ts',
      commitId: 'd'.repeat(40),
      worktreeId: 'worktree-infra',
      canonicalSourceEntryId: 'source-entry',
      opencodeConfigEntryId: 'source-config',
    },
  })
}

function withoutOpaqueRunId(
  result: ReturnType<typeof normalizeResult>,
): ReturnType<typeof normalizeResult> {
  return { ...result, runId: 'run-opaque' }
}

function countEvalServeProcesses(): number {
  const result = Bun.spawnSync(['ps', '-axo', 'command='])
  if (result.exitCode !== 0) return 0
  return result.stdout
    .toString()
    .split('\n')
    .filter(
      (line) =>
        line.includes(`opencode-ai@${EXPECTED_OPENCODE_VERSION}`) &&
        line.includes('serve'),
    ).length
}

function normalizeRunIdentity<T>(value: T, runIds: readonly string[]): T {
  if (typeof value === 'string') {
    return runIds.reduce(
      (result, runId) => result.replaceAll(runId, 'run-opaque'),
      value,
    ) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeRunIdentity(item, runIds)) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        normalizeRunIdentity(nested, runIds),
      ]),
    ) as T
  }
  return value
}

function requireSubcode(subcode: EvalSubcode | undefined): EvalSubcode {
  if (subcode === undefined) {
    throw new Error('expected result.subcode to be defined')
  }
  return subcode
}

async function waitForMarker(
  markerPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(markerPath)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('started-child marker timeout')
}

describe('local OpenCode eval runner', () => {
  test('real-case outcome helpers reject bounded infrastructure results', () => {
    const result = boundedInfraResult()
    expect(() => expectRuntimeOutcome(result)).toThrow()
    expect(() => expectRuntimeOutcome(result)).toThrow()
  })

  // This test itself is skipped offline (test.skipIf below) since it starts
  // a real host; the tolerant infra_failure branch inside it is not a local
  // skip mechanism, it's the CI fail-closed boundary from Unit 3 (an
  // opencode_unavailable/identity_drift outcome tightens to a hard failure
  // under SYSTEMATIC_REQUIRE_OPENCODE=1). The offline "doesn't silently
  // skip" guarantee for the unavailable path is covered instead by the
  // ungated `timeoutMs: 1` test below, which runs with no host required.
  test.skipIf(!OPENCODE_AVAILABLE)(
    'gates grading on exact OpenCode runtime identity without silently skipping (online only; see the ungated timeoutMs:1 test for the offline path)',
    async () => {
      const parentDir = runParent()
      try {
        const result = await runSourceEval({
          caseId: 'bootstrap-loading',
          fixtureSeed: 'runner-runtime-gate',
          normalizedClock: FIXED_CLOCK,
          parentDir,
        })
        const normalized = normalizeResult(result)

        if (normalized.outcome === 'infra_failure') {
          expect(['opencode_unavailable', 'identity_drift']).toContain(
            requireSubcode(normalized.subcode),
          )
        } else {
          expect(normalized.identity.opencodeVersion).toBe(
            EXPECTED_OPENCODE_VERSION,
          )
        }
      } finally {
        fs.rmSync(parentDir, { recursive: true, force: true })
      }
    },
    360_000,
  )

  test.skipIf(!OPENCODE_AVAILABLE)(
    'runs bootstrap-loading from bounded probe evidence when exact runtime is available',
    async () => {
      const parentDir = runParent()
      try {
        const result = normalizeResult(
          await runSourceEval({
            caseId: 'bootstrap-loading',
            fixtureSeed: 'runner-bootstrap',
            normalizedClock: FIXED_CLOCK,
            parentDir,
          }),
        )
        expectRuntimeOutcome(result)
        expect(result.mode).toBe('source')
        expect(result.fixtureSeed).toBe('runner-bootstrap')
        expect(result.normalizedClock).toBe(FIXED_CLOCK)
        expect(result.assertionIds).toEqual(['bootstrap-observed'])
        expect(result.evidence.sanity).toBe('passed')
        expect(result.evidence.process).toBe('completed')
        expect(result.evidence.assertionIds).toEqual(['bootstrap-observed'])
        const promptComposition = result.evidence.promptComposition
        if (!promptComposition) {
          throw new Error('bootstrap prompt composition evidence missing')
        }
        expect(promptComposition).toMatchObject({
          systematicCatalog: {
            state: 'absent',
            entryCount: 0,
            skillNames: [],
          },
          hostCatalog: {
            state: 'present',
          },
        })
        expect(promptComposition.hostCatalog.entryCount).toBeGreaterThan(0)
        expect(promptComposition.hostCatalog.skillNames.length).toBeGreaterThan(
          0,
        )

        // OpenCode renders raw SKILL.md names; the Systematic prefix belongs only
        // to the retained systematic_skill description surface.
        const expectedHostSkillNames = buildCatalogEntries({
          bundledSkillsDir: path.join(ROOT_DIR, 'skills'),
          disabledSkills: [],
        }).map((entry) => entry.name)
        expect(expectedHostSkillNames.length).toBeGreaterThan(0)
        const hostCoverage = gradeHostSkillCoverage(
          [
            { type: 'loaded', status: 'ok' },
            {
              type: 'transform',
              kind: 'chat',
              status: 'healthy',
              blockCount: 1,
              promptComposition,
            },
          ],
          expectedHostSkillNames,
        )
        expect(hostCoverage).toMatchObject({
          outcome: 'success',
          subcode: 'none',
          hostCatalogCoverage: {
            state: 'present',
            missingSkillNames: [],
          },
        })
        expect(result.evidence).toMatchObject({
          sanity: 'passed',
          process: 'completed',
          assertionIds: ['bootstrap-observed'],
        })
        expect(result.cleanup).toEqual({ status: 'clean', residue: 'none' })
        expect(result.provenance.kind).toBe('source')
        expect(JSON.stringify(result)).not.toContain('stdout')
        expect(JSON.stringify(result)).not.toContain('stderr')
      } finally {
        fs.rmSync(parentDir, { recursive: true, force: true })
      }
    },
    360_000,
  )

  test.skipIf(!OPENCODE_AVAILABLE)(
    'writes and grades fixture-local-write exact content when runtime is available',
    async () => {
      const parentDir = runParent()
      try {
        const result = normalizeResult(
          await runSourceEval({
            caseId: 'fixture-local-write',
            fixtureSeed: 'runner-local-write',
            normalizedClock: FIXED_CLOCK,
            parentDir,
          }),
        )
        expectRuntimeOutcome(result)
        expect(result.assertionIds).toEqual([
          'fixture-file-content',
          'fixture-file-created',
        ])
        expect(result.provenance.kind).toBe('source')
        expect(result.cleanup).toEqual({ status: 'clean', residue: 'none' })
        expect(JSON.stringify(result)).not.toContain('fixture-local-write-v1')
      } finally {
        fs.rmSync(parentDir, { recursive: true, force: true })
      }
    },
    360_000,
  )

  test('classifies missing or unhealthy probe and missing fixture output with bounded results', () => {
    const missingProbe = gradeBootstrapProbe([])
    expect(missingProbe).toEqual({
      status: 'unhealthy',
      subcode: 'probe_unhealthy',
      promptComposition: {
        bootstrapPayloadSize: 0,
        systematicCatalog: {
          state: 'impossible',
          entryCount: 0,
          skillNames: [],
        },
        hostCatalog: {
          state: 'impossible',
          entryCount: 0,
          skillNames: [],
        },
      },
    })

    const malformedProbe: BoundedProbeEvent[] = [
      { type: 'loaded', status: 'ok' },
      { type: 'transform', kind: 'chat', status: 'unhealthy', blockCount: 0 },
    ]
    expect(gradeBootstrapProbe(malformedProbe)).toEqual({
      status: 'unhealthy',
      subcode: 'probe_unhealthy',
      promptComposition: {
        bootstrapPayloadSize: 0,
        systematicCatalog: {
          state: 'impossible',
          entryCount: 0,
          skillNames: [],
        },
        hostCatalog: {
          state: 'impossible',
          entryCount: 0,
          skillNames: [],
        },
      },
    })

    const parentDir = runParent()
    const projectRoot = path.join(parentDir, 'project')
    fs.mkdirSync(projectRoot, { recursive: true })
    try {
      expect(
        gradeFixtureWrite(projectRoot, {
          expectedArtifactId: 'fixture/output.txt',
          expectedContentId: 'fixture-local-write-v1',
        }),
      ).toEqual({ outcome: 'task_failure', subcode: 'write_missing' })
      fs.mkdirSync(path.join(projectRoot, 'fixture'), { recursive: true })
      fs.writeFileSync(
        path.join(projectRoot, 'fixture/output.txt'),
        'wrong-content',
      )
      expect(
        gradeFixtureWrite(projectRoot, {
          expectedArtifactId: 'fixture/output.txt',
          expectedContentId: 'fixture-local-write-v1',
        }),
      ).toEqual({ outcome: 'task_failure', subcode: 'write_mismatch' })
      fs.writeFileSync(
        path.join(projectRoot, 'fixture/output.txt'),
        'fixture-local-write-v1',
      )
      expect(
        gradeFixtureWrite(projectRoot, {
          expectedArtifactId: 'fixture/output.txt',
          expectedContentId: 'fixture-local-write-v1',
        }),
      ).toEqual({ outcome: 'success', subcode: 'none' })
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('grades host catalog coverage as a set and fails closed for absent or impossible observations', async () => {
    const opencodeModule = (await import(
      '../../scripts/eval-cases/opencode.ts'
    )) as unknown as Record<string, unknown>
    expect(typeof opencodeModule.gradeHostSkillCoverage).toBe('function')
    if (typeof opencodeModule.gradeHostSkillCoverage !== 'function') return

    const gradeHostSkillCoverage = opencodeModule.gradeHostSkillCoverage as (
      events: readonly BoundedProbeEvent[],
      expectedSkillNames: readonly string[],
    ) => unknown
    const expectedSkillNames = ['agent-browser', 'ce:brainstorm']
    const presentPromptComposition = {
      bootstrapPayloadSize: 100,
      systematicCatalog: {
        state: 'present' as const,
        entryCount: 1,
        skillNames: ['systematic:agent-browser'],
      },
      hostCatalog: {
        state: 'present' as const,
        entryCount: 3,
        skillNames: ['agent-browser', 'ce:brainstorm', 'extra-skill'],
      },
    }
    const presentEvents: BoundedProbeEvent[] = [
      { type: 'loaded', status: 'ok' },
      {
        type: 'transform',
        kind: 'chat',
        status: 'healthy',
        blockCount: 1,
        promptComposition: presentPromptComposition,
      },
    ]

    expect(gradeHostSkillCoverage(presentEvents, expectedSkillNames)).toEqual({
      outcome: 'success',
      subcode: 'none',
      promptComposition: presentPromptComposition,
      hostCatalogCoverage: {
        state: 'present',
        expectedSkillNames,
        observedSkillNames: ['agent-browser', 'ce:brainstorm', 'extra-skill'],
        missingSkillNames: [],
      },
    })

    const partialPromptComposition = {
      ...presentPromptComposition,
      hostCatalog: {
        state: 'present' as const,
        entryCount: 1,
        skillNames: ['agent-browser'],
      },
    }
    expect(
      gradeHostSkillCoverage(
        [
          presentEvents[0] as BoundedProbeEvent,
          {
            ...presentEvents[1],
            promptComposition: partialPromptComposition,
          } as BoundedProbeEvent,
        ],
        expectedSkillNames,
      ),
    ).toEqual({
      outcome: 'task_failure',
      subcode: 'host_catalog_incomplete',
      promptComposition: partialPromptComposition,
      hostCatalogCoverage: {
        state: 'present',
        expectedSkillNames,
        observedSkillNames: ['agent-browser'],
        missingSkillNames: ['ce:brainstorm'],
      },
    })

    const absentPromptComposition = {
      ...presentPromptComposition,
      hostCatalog: {
        state: 'absent' as const,
        entryCount: 0,
        skillNames: [],
      },
    }
    expect(
      gradeHostSkillCoverage(
        [
          presentEvents[0] as BoundedProbeEvent,
          {
            ...presentEvents[1],
            promptComposition: absentPromptComposition,
          } as BoundedProbeEvent,
        ],
        expectedSkillNames,
      ),
    ).toEqual({
      outcome: 'task_failure',
      subcode: 'host_catalog_absent',
      promptComposition: absentPromptComposition,
      hostCatalogCoverage: {
        state: 'absent',
        expectedSkillNames,
        observedSkillNames: [],
        missingSkillNames: expectedSkillNames,
      },
    })

    expect(gradeHostSkillCoverage([], expectedSkillNames)).toEqual({
      outcome: 'infra_failure',
      subcode: 'probe_unhealthy',
      promptComposition: {
        bootstrapPayloadSize: 0,
        systematicCatalog: {
          state: 'impossible',
          entryCount: 0,
          skillNames: [],
        },
        hostCatalog: {
          state: 'impossible',
          entryCount: 0,
          skillNames: [],
        },
      },
      hostCatalogCoverage: {
        state: 'impossible',
        expectedSkillNames,
        observedSkillNames: [],
        missingSkillNames: [],
      },
    })

    const laterCompletePromptComposition = presentPromptComposition
    expect(
      gradeHostSkillCoverage(
        [
          presentEvents[0],
          {
            type: 'transform',
            kind: 'chat',
            status: 'healthy',
            blockCount: 1,
            promptComposition: {
              bootstrapPayloadSize: 0,
              systematicCatalog: {
                state: 'impossible',
                entryCount: 0,
                skillNames: [],
              },
              hostCatalog: {
                state: 'impossible',
                entryCount: 0,
                skillNames: [],
              },
            },
          },
          {
            type: 'transform',
            kind: 'chat',
            status: 'healthy',
            blockCount: 1,
            promptComposition: laterCompletePromptComposition,
          },
        ],
        expectedSkillNames,
      ),
    ).toMatchObject({
      outcome: 'infra_failure',
      subcode: 'probe_unhealthy',
    })
  })

  test('classifies an undiagnosed host-started prompt failure without a transform as infrastructure failure', async () => {
    const opencodeModule = (await import(
      '../../scripts/eval-cases/opencode.ts'
    )) as unknown as Record<string, unknown>
    expect(typeof opencodeModule.classifyExecutionFailure).toBe('function')
    if (typeof opencodeModule.classifyExecutionFailure !== 'function') return

    const classifyExecutionFailure =
      opencodeModule.classifyExecutionFailure as (
        hostStarted: boolean,
        error: unknown,
        events: readonly BoundedProbeEvent[],
        probeDigest: string,
      ) => { outcome: string; subcode?: string }
    expect(
      classifyExecutionFailure(
        true,
        new Error('opencode-prompt-failed'),
        [],
        'a'.repeat(64),
      ),
    ).toMatchObject({
      outcome: 'infra_failure',
      subcode: 'probe_unhealthy',
    })
  })

  test('classifies a diagnosed host-started prompt timeout as task failure', async () => {
    const opencodeModule = (await import(
      '../../scripts/eval-cases/opencode.ts'
    )) as unknown as Record<string, unknown>
    expect(typeof opencodeModule.classifyExecutionFailure).toBe('function')
    if (typeof opencodeModule.classifyExecutionFailure !== 'function') return

    const classifyExecutionFailure =
      opencodeModule.classifyExecutionFailure as (
        hostStarted: boolean,
        error: unknown,
        events: readonly BoundedProbeEvent[],
        probeDigest: string,
      ) => { outcome: string; subcode?: string }
    expect(
      classifyExecutionFailure(
        true,
        new Error('opencode-prompt-timeout'),
        [],
        'a'.repeat(64),
      ),
    ).toMatchObject({
      outcome: 'task_failure',
      subcode: 'unexpected_exit',
    })
  })

  test('scopes Systematic and host catalogs independently around the workflow block', () => {
    const observation = observePromptComposition([
      [
        '<available_skills>',
        '  <skill><name>host:alpha</name></skill>',
        '</available_skills>',
        '<SYSTEMATIC_WORKFLOWS>',
        'bootstrap body',
        '<available_skills>',
        '  <skill><name>systematic:alpha</name></skill>',
        '  <skill><name>systematic:beta</name></skill>',
        '</available_skills>',
        '</SYSTEMATIC_WORKFLOWS>',
      ].join('\n'),
    ])

    expect(observation).toEqual({
      bootstrapPayloadSize: expect.any(Number),
      systematicCatalog: {
        state: 'present',
        entryCount: 2,
        skillNames: ['systematic:alpha', 'systematic:beta'],
      },
      hostCatalog: {
        state: 'present',
        entryCount: 1,
        skillNames: ['host:alpha'],
      },
    })
    expect(observation.bootstrapPayloadSize).toBeGreaterThan(0)
  })

  test('fails closed when workflow markers are unmatched or nested', () => {
    const catalog =
      '<available_skills>\n<skill><name>systematic:agent-browser</name></skill>\n</available_skills>'
    const impossible = {
      bootstrapPayloadSize: 0,
      systematicCatalog: {
        state: 'impossible' as const,
        entryCount: 0,
        skillNames: [],
      },
      hostCatalog: {
        state: 'impossible' as const,
        entryCount: 0,
        skillNames: [],
      },
    }

    expect(
      observePromptComposition([`<SYSTEMATIC_WORKFLOWS>\n${catalog}`]),
    ).toEqual(impossible)
    expect(
      observePromptComposition([`${catalog}\n</SYSTEMATIC_WORKFLOWS>`]),
    ).toEqual(impossible)
    expect(
      observePromptComposition([
        `<SYSTEMATIC_WORKFLOWS><SYSTEMATIC_WORKFLOWS>${catalog}</SYSTEMATIC_WORKFLOWS></SYSTEMATIC_WORKFLOWS>`,
      ]),
    ).toEqual(impossible)
  })

  test('does not count a catalog duplicated outside the workflow as host coverage', () => {
    const catalog =
      '<available_skills>\n<skill><name>systematic:agent-browser</name></skill>\n</available_skills>'
    const observation = observePromptComposition([
      `<SYSTEMATIC_WORKFLOWS>${catalog}</SYSTEMATIC_WORKFLOWS>\n${catalog}`,
    ])

    expect(observation.systematicCatalog).toEqual({
      state: 'present',
      entryCount: 1,
      skillNames: ['systematic:agent-browser'],
    })
    expect(observation.hostCatalog).toEqual({
      state: 'absent',
      entryCount: 0,
      skillNames: [],
    })
    expect(
      gradeHostSkillCoverage(
        [
          { type: 'loaded', status: 'ok' },
          {
            type: 'transform',
            kind: 'chat',
            status: 'healthy',
            blockCount: 1,
            promptComposition: observation,
          },
        ],
        ['systematic:agent-browser'],
      ),
    ).toMatchObject({
      outcome: 'task_failure',
      subcode: 'host_catalog_absent',
    })
  })

  test('disabled_skills exclusions are removed from the expected coverage set', () => {
    const disabledSkill = 'agent-browser'
    const filteredEntries = buildCatalogEntries({
      bundledSkillsDir: path.join(ROOT_DIR, 'skills'),
      disabledSkills: [disabledSkill],
    })
    const expectedSkillNames = filteredEntries.map((entry) => entry.name)
    const promptComposition = {
      bootstrapPayloadSize: 100,
      systematicCatalog: {
        state: 'present' as const,
        entryCount: expectedSkillNames.length,
        skillNames: filteredEntries.map((entry) => entry.prefixedName),
      },
      hostCatalog: {
        state: 'present' as const,
        entryCount: expectedSkillNames.length,
        skillNames: expectedSkillNames,
      },
    }

    expect(expectedSkillNames).not.toContain(disabledSkill)
    expect(
      gradeHostSkillCoverage(
        [
          { type: 'loaded', status: 'ok' },
          {
            type: 'transform',
            kind: 'chat',
            status: 'healthy',
            blockCount: 1,
            promptComposition,
          },
        ],
        expectedSkillNames,
      ),
    ).toMatchObject({ outcome: 'success', subcode: 'none' })
  })

  test('reports an observed empty prompt catalog as absent rather than impossible', () => {
    expect(
      observePromptComposition([
        '<SYSTEMATIC_WORKFLOWS>\nbootstrap body\n</SYSTEMATIC_WORKFLOWS>',
      ]),
    ).toEqual({
      bootstrapPayloadSize: expect.any(Number),
      systematicCatalog: {
        state: 'absent',
        entryCount: 0,
        skillNames: [],
      },
      hostCatalog: {
        state: 'absent',
        entryCount: 0,
        skillNames: [],
      },
    })
  })

  test('keeps the generated probe observation implementation behaviorally identical', async () => {
    const catalog = (name: string) =>
      `<available_skills>\n<skill><name>${name}</name></skill>\n</available_skills>`
    const systematicCatalog = catalog('systematic:alpha')
    const hostCatalog = catalog('host:alpha')
    const validSystem = [
      `<SYSTEMATIC_WORKFLOWS>\n${systematicCatalog}\n</SYSTEMATIC_WORKFLOWS>`,
    ]
    const corpus: readonly (readonly unknown[])[] = [
      validSystem,
      [`<SYSTEMATIC_WORKFLOWS>\n${systematicCatalog}`],
      [`${systematicCatalog}\n</SYSTEMATIC_WORKFLOWS>`],
      [
        `<SYSTEMATIC_WORKFLOWS><SYSTEMATIC_WORKFLOWS>${systematicCatalog}</SYSTEMATIC_WORKFLOWS></SYSTEMATIC_WORKFLOWS>`,
      ],
      [
        `<SYSTEMATIC_WORKFLOWS>${systematicCatalog}</SYSTEMATIC_WORKFLOWS>\n${systematicCatalog}`,
      ],
      [
        `${hostCatalog}\n<SYSTEMATIC_WORKFLOWS>\n${systematicCatalog}\n</SYSTEMATIC_WORKFLOWS>`,
      ],
      [validSystem[0], { role: 'system', content: 'not a string entry' }],
    ]
    const parentDir = runParent()
    const fixture = createEvalFixture({
      caseId: 'bootstrap-loading',
      mode: 'source',
      runId: 'probe-differential',
      parentDir,
    })

    try {
      const probe = createOpencodeProbe(fixture)
      const generatedProbe = (await import(
        `${pathToFileURL(probe.sourcePath).href}?differential`
      )) as {
        observePromptComposition?: (system: readonly unknown[]) => unknown
      }
      expect(typeof generatedProbe.observePromptComposition).toBe('function')
      if (typeof generatedProbe.observePromptComposition !== 'function') return

      const typedObservations = corpus.map((system) =>
        observePromptComposition(system),
      )
      const generatedObservations = corpus.map((system) =>
        generatedProbe.observePromptComposition?.(system),
      )

      expect(generatedObservations).toEqual(typedObservations)
      expect(typedObservations[0]).toMatchObject({
        systematicCatalog: { state: 'present' },
      })
      expect(generatedObservations[0]).toMatchObject({
        systematicCatalog: { state: 'present' },
      })
    } finally {
      cleanupEvalFixture(fixture)
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('persists prompt composition facts before the final manifest rename', () => {
    const parentDir = runParent()
    const runsRoot = path.join(parentDir, 'runs')
    const promptComposition = {
      bootstrapPayloadSize: 18_145,
      systematicCatalog: {
        state: 'present' as const,
        entryCount: 23,
        skillNames: ['systematic:alpha', 'systematic:beta'],
      },
      hostCatalog: {
        state: 'absent' as const,
        entryCount: 0,
        skillNames: [],
      },
    }
    const result = normalizeResult({
      ...syntheticResult({
        caseId: 'bootstrap-loading',
        mode: 'source',
        runId: 'run-prompt-facts',
        outcome: 'success',
        subcode: 'none',
      }),
      evidence: {
        sanity: 'passed',
        process: 'completed',
        assertionIds: ['bootstrap-observed'],
        promptComposition,
      },
    })

    try {
      const renameOrder: string[] = []
      persistEvalRun({
        runsRoot,
        manifest: {
          manifestSchemaVersion: 1,
          harness: 'opencode',
          runId: 'run-prompt-facts',
          requestedSelectionIds: ['bootstrap-loading/source'],
          completedSelectionIds: ['bootstrap-loading/source'],
          partial: false,
          results: [
            {
              selectionId: 'bootstrap-loading/source',
              resultArtifactId: 'results/bootstrap-loading/source.json',
              outcome: 'success',
              subcode: 'none',
            },
          ],
        },
        results: [result],
        onRename: (relativeId) => renameOrder.push(relativeId),
      })

      expect(renameOrder).toEqual([
        'results/bootstrap-loading/source.json',
        'manifest.json',
      ])
      expect(
        validateSerializedResult(
          fs.readFileSync(
            path.join(
              runsRoot,
              'run-prompt-facts/results/bootstrap-loading/source.json',
            ),
          ),
        ).evidence.promptComposition,
      ).toEqual(promptComposition)
      expect(
        validateSerializedRunManifest(
          fs.readFileSync(
            path.join(runsRoot, 'run-prompt-facts/manifest.json'),
          ),
        ).results,
      ).toHaveLength(1)
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('returns bounded failure and removes temporary roots on timeout', async () => {
    const parentDir = runParent()
    try {
      const result = normalizeResult(
        await runSourceEval({
          caseId: 'bootstrap-loading',
          fixtureSeed: 'runner-timeout',
          normalizedClock: FIXED_CLOCK,
          parentDir,
          timeoutMs: 1,
        }),
      )
      expect(result.outcome).toBe('infra_failure')
      expect(['opencode_unavailable', 'identity_drift']).toContain(
        requireSubcode(result.subcode),
      )
      expect(result.cleanup).toEqual({ status: 'clean', residue: 'none' })
      expect(fs.readdirSync(parentDir)).toEqual([])
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  }, 30_000)

  test.skipIf(!OPENCODE_AVAILABLE)(
    'classifies a started-host case timeout as task failure and cleans every root',
    async () => {
      const parentDir = runParent()
      const processCountBefore = countEvalServeProcesses()
      try {
        const options = {
          caseId: 'bootstrap-loading' as const,
          fixtureSeed: 'runner-started-timeout',
          normalizedClock: FIXED_CLOCK,
          parentDir,
          timeoutMs: 360_000,
          caseTimeoutMs: 1,
        }
        const result = normalizeResult(await runSourceEval(options))

        expect(result.outcome).toBe('task_failure')
        expect(result.subcode).toBe('unexpected_exit')
        expect(result.cleanup).toEqual({ status: 'clean', residue: 'none' })
        expect(fs.readdirSync(parentDir)).toEqual([])
        expect(countEvalServeProcesses()).toBe(processCountBefore)
      } finally {
        fs.rmSync(parentDir, { recursive: true, force: true })
      }
    },
    360_000,
  )

  test.skipIf(!OPENCODE_AVAILABLE)(
    'repeated source runs normalize to equal evidence and preserve checkout identity',
    async () => {
      const before = capturePrimaryCheckout()
      const parentDir = runParent()
      try {
        const first = normalizeResult(
          await runSourceEval({
            caseId: 'bootstrap-loading',
            fixtureSeed: 'runner-repeat',
            normalizedClock: FIXED_CLOCK,
            parentDir,
          }),
        )
        const second = normalizeResult(
          await runSourceEval({
            caseId: 'bootstrap-loading',
            fixtureSeed: 'runner-repeat',
            normalizedClock: FIXED_CLOCK,
            parentDir,
          }),
        )

        expect(withoutOpaqueRunId(first)).toEqual(withoutOpaqueRunId(second))
        expect(capturePrimaryCheckout()).toEqual(before)
        expect(first.artifactRefs).not.toContain(first.runId)
        expect(second.artifactRefs).not.toContain(second.runId)
      } finally {
        fs.rmSync(parentDir, { recursive: true, force: true })
      }
    },
    720_000,
  )

  test.skipIf(!OPENCODE_AVAILABLE)(
    'source and installed bootstrap runs succeed with disjoint provenance and matching catalog evidence',
    async () => {
      const sourceParent = runParent()
      const installedParent = runParent()
      try {
        const source = normalizeResult(
          await runSourceEval({
            caseId: 'bootstrap-loading',
            fixtureSeed: 'runner-installed-bootstrap',
            normalizedClock: FIXED_CLOCK,
            parentDir: sourceParent,
          }),
        )
        const installed = normalizeResult(
          await runInstalledEval({
            caseId: 'bootstrap-loading',
            fixtureSeed: 'runner-installed-bootstrap',
            normalizedClock: FIXED_CLOCK,
            parentDir: installedParent,
          }),
        )

        expectRuntimeOutcome(source)
        expectRuntimeOutcome(installed)
        expect(source.evidence).toMatchObject({
          sanity: 'passed',
          process: 'completed',
          assertionIds: ['bootstrap-observed'],
        })
        expect(installed.evidence).toMatchObject({
          sanity: 'passed',
          process: 'completed',
          assertionIds: ['bootstrap-observed'],
        })
        expect(source.evidence.promptComposition?.systematicCatalog).toEqual(
          installed.evidence.promptComposition?.systematicCatalog,
        )
        expect(source.evidence.promptComposition?.hostCatalog).toEqual(
          installed.evidence.promptComposition?.hostCatalog,
        )
        expect(
          source.evidence.promptComposition?.bootstrapPayloadSize,
        ).toBeGreaterThan(0)
        expect(
          installed.evidence.promptComposition?.bootstrapPayloadSize,
        ).toBeGreaterThan(0)
        expect(source.mode).toBe('source')
        expect(installed.mode).toBe('installed')
        expect(source.provenance).toMatchObject({
          kind: 'source',
          checkoutRelativeSource: 'src/index.ts',
          canonicalSourceEntryId: 'source-entry',
          opencodeConfigEntryId: 'source-config',
        })
        expect(installed.provenance).toMatchObject({
          kind: 'installed',
          packageName: '@fro.bot/systematic',
          packageVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
          tarballDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          extractedPackageRootId: 'installed-package-root',
          canonicalResolvedModuleEntryId: 'dist/index.js',
          opencodeConfigEntryId: 'installed-config',
        })
        expect(installed.identity.artifactId).toBe('installed-entry')
        expect(JSON.stringify(installed)).not.toContain(sourceParent)
        expect(JSON.stringify(installed)).not.toContain('src/index.ts')
      } finally {
        fs.rmSync(sourceParent, { recursive: true, force: true })
        fs.rmSync(installedParent, { recursive: true, force: true })
      }
    },
    720_000,
  )

  test.skipIf(!OPENCODE_AVAILABLE)(
    'host-skill-coverage passes in source and installed modes with complete observed coverage',
    async () => {
      const sourceParent = runParent()
      const installedParent = runParent()
      try {
        const source = normalizeResult(
          await runSourceEval({
            caseId: 'host-skill-coverage',
            fixtureSeed: 'runner-host-skill-coverage',
            normalizedClock: FIXED_CLOCK,
            parentDir: sourceParent,
          }),
        )
        const installed = normalizeResult(
          await runInstalledEval({
            caseId: 'host-skill-coverage',
            fixtureSeed: 'runner-host-skill-coverage',
            normalizedClock: FIXED_CLOCK,
            parentDir: installedParent,
          }),
        )

        expectRuntimeOutcome(source)
        expectRuntimeOutcome(installed)
        expect(source.assertionIds).toEqual(['host-catalog-covered'])
        expect(installed.assertionIds).toEqual(['host-catalog-covered'])
        const sourceCoverage = source.evidence.hostCatalogCoverage
        const installedCoverage = installed.evidence.hostCatalogCoverage
        if (!sourceCoverage || !installedCoverage) {
          throw new Error('host catalog coverage evidence missing')
        }
        expect(sourceCoverage).toMatchObject({
          state: 'present',
          missingSkillNames: [],
        })
        expect(installedCoverage).toMatchObject({
          state: 'present',
          missingSkillNames: [],
        })
        expect(sourceCoverage.expectedSkillNames.length).toBeGreaterThan(0)
        expect(installedCoverage.expectedSkillNames.length).toBeGreaterThan(0)
        expect(
          sourceCoverage.expectedSkillNames.every((name) =>
            sourceCoverage.observedSkillNames.includes(name),
          ),
        ).toBe(true)
        expect(
          installedCoverage.expectedSkillNames.every((name) =>
            installedCoverage.observedSkillNames.includes(name),
          ),
        ).toBe(true)
        expect(sourceCoverage).toEqual(installedCoverage)
        expect(source.evidence.promptComposition?.hostCatalog.state).toBe(
          'present',
        )
        expect(installed.evidence.promptComposition?.hostCatalog.state).toBe(
          'present',
        )
        expect(JSON.stringify(source)).not.toContain('<available_skills>')
        expect(JSON.stringify(installed)).not.toContain('<available_skills>')
      } finally {
        fs.rmSync(sourceParent, { recursive: true, force: true })
        fs.rmSync(installedParent, { recursive: true, force: true })
      }
    },
    720_000,
  )

  test.skipIf(!OPENCODE_AVAILABLE)(
    'installed fixture-local-write grades exact content without source fallback',
    async () => {
      const parentDir = runParent()
      try {
        const result = normalizeResult(
          await runInstalledEval({
            caseId: 'fixture-local-write',
            fixtureSeed: 'runner-installed-write',
            normalizedClock: FIXED_CLOCK,
            parentDir,
          }),
        )
        expectRuntimeOutcome(result)
        expect(result.mode).toBe('installed')
        expect(result.assertionIds).toEqual([
          'fixture-file-content',
          'fixture-file-created',
        ])
        expect(result.provenance.kind).toBe('installed')
        expect(result.cleanup).toEqual({ status: 'clean', residue: 'none' })
        expect(JSON.stringify(result)).not.toContain(parentDir)
        expect(JSON.stringify(result)).not.toContain('src/index.ts')
      } finally {
        fs.rmSync(parentDir, { recursive: true, force: true })
      }
    },
    360_000,
  )

  test('cleanup runs after success, task failure, and a started-child interruption', async () => {
    const parentDir = runParent()
    const cleanupCalls: string[] = []
    try {
      for (const [label, execution] of [
        ['success', syntheticExecution('success', 'none')],
        ['task-failure', syntheticExecution('task_failure', 'write_mismatch')],
        [
          'started-child-interruption',
          syntheticExecution('task_failure', 'unexpected_exit'),
        ],
      ] as const) {
        const result = normalizeResult(
          await runSourceEval({
            caseId: 'bootstrap-loading',
            fixtureSeed: `cleanup-${label}`,
            normalizedClock: FIXED_CLOCK,
            parentDir,
            lifecycleHooks: {
              executeCase: async () => execution,
              cleanupFixture: (fixture) => {
                cleanupCalls.push(label)
                fs.rmSync(fixture.runRoot, { recursive: true, force: true })
              },
            },
          }),
        )

        expect(result.cleanup).toEqual({ status: 'clean', residue: 'none' })
        expect(result.outcome).toBe(execution.outcome)
        expect(result.subcode).toBe(execution.subcode)
      }

      expect(cleanupCalls).toEqual([
        'success',
        'task-failure',
        'started-child-interruption',
      ])
      expect(fs.readdirSync(parentDir)).toEqual([])
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('source lifecycle setup throws return bounded case_setup results and clean the fixture', async () => {
    const parentDir = runParent()
    try {
      const result = normalizeResult(
        await runSourceEval({
          caseId: 'bootstrap-loading',
          fixtureSeed: 'setup-throws',
          normalizedClock: FIXED_CLOCK,
          parentDir,
          lifecycleHooks: {
            executeCase: async () => {
              throw new Error('injected source setup failure')
            },
          },
        }),
      )

      expect(result.outcome).toBe('infra_failure')
      expect(result.subcode).toBe('case_setup')
      expect(result.cleanup).toEqual({ status: 'clean', residue: 'none' })
      expect(fs.readdirSync(parentDir)).toEqual([])
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('cleanup failure overrides success and quarantines residue with unique targets', async () => {
    const parentDir = runParent()
    const quarantineTargets: string[] = []
    try {
      for (const seed of ['cleanup-residue-one', 'cleanup-residue-two']) {
        const result = normalizeResult(
          await runSourceEval({
            caseId: 'bootstrap-loading',
            fixtureSeed: seed,
            normalizedClock: FIXED_CLOCK,
            parentDir,
            lifecycleHooks: {
              executeCase: async () => syntheticExecution('success', 'none'),
              cleanupFixture: () => undefined,
              quarantineResidue: (fixture, quarantineRoot) => {
                quarantineTargets.push(quarantineRoot)
                fs.renameSync(fixture.runRoot, quarantineRoot)
              },
            },
          }),
        )

        expect(result.outcome).toBe('privacy_cleanup_failure')
        expect(result.subcode).toBe('residue_detected')
        expect(result.cleanup).toEqual({
          status: 'quarantined',
          residue: 'quarantined',
        })
      }

      expect(quarantineTargets).toHaveLength(2)
      expect(new Set(quarantineTargets).size).toBe(2)
      for (const target of quarantineTargets)
        expect(fs.existsSync(target)).toBe(true)
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('quarantine failure remains bounded and reports unresolved residue', async () => {
    const parentDir = runParent()
    try {
      const result = normalizeResult(
        await runSourceEval({
          caseId: 'bootstrap-loading',
          fixtureSeed: 'cleanup-quarantine-failure',
          normalizedClock: FIXED_CLOCK,
          parentDir,
          lifecycleHooks: {
            executeCase: async () => syntheticExecution('success', 'none'),
            cleanupFixture: () => undefined,
            quarantineResidue: () => {
              throw new Error('injected quarantine failure')
            },
          },
        }),
      )

      expect(result.outcome).toBe('privacy_cleanup_failure')
      expect(result.subcode).toBe('quarantine_failed')
      expect(result.cleanup).toEqual({ status: 'residue', residue: 'detected' })
      expect(JSON.stringify(result)).not.toContain(parentDir)
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('cleanup precedence keeps privacy cleanup failure when checkout readback also changes', async () => {
    const parentDir = runParent()
    const checkoutRoot = path.join(parentDir, 'checkout')
    fs.mkdirSync(path.join(checkoutRoot, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(checkoutRoot, 'src/index.ts'),
      'export default {}',
    )
    const manifestPath = path.join(
      checkoutRoot,
      'evals/cases/opencode/bootstrap-loading.json',
    )
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.copyFileSync(
      path.join(
        path.resolve(import.meta.dirname, '../..'),
        'evals/cases/opencode/bootstrap-loading.json',
      ),
      manifestPath,
    )
    const init = Bun.spawnSync(['git', 'init', '-q'], { cwd: checkoutRoot })
    expect(init.exitCode).toBe(0)

    try {
      const result = normalizeResult(
        await runSourceEval({
          caseId: 'bootstrap-loading',
          fixtureSeed: 'cleanup-precedence',
          normalizedClock: FIXED_CLOCK,
          parentDir,
          rootDir: checkoutRoot,
          lifecycleHooks: {
            executeCase: async () => {
              fs.writeFileSync(
                path.join(checkoutRoot, 'checkout-delta.txt'),
                'delta',
              )
              return syntheticExecution('success', 'none')
            },
            cleanupFixture: () => undefined,
            quarantineResidue: (fixture, quarantineRoot) => {
              fs.renameSync(fixture.runRoot, quarantineRoot)
            },
          },
        }),
      )

      expect(result.outcome).toBe('privacy_cleanup_failure')
      expect(result.subcode).toBe('residue_detected')
      expect(result.cleanup).toEqual({
        status: 'quarantined',
        residue: 'quarantined',
      })
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('continues task failures, aborts runner-wide failures, and packs installed selections once', async () => {
    const parentDir = runParent()
    const runsRoot = path.join(parentDir, 'runs')
    let packCalls = 0
    const calls: string[] = []
    try {
      const run = await runEvalSelections({
        selectionIds: [
          'bootstrap-loading/installed',
          'bootstrap-loading/source',
          'fixture-local-write/installed',
          'fixture-local-write/source',
        ],
        fixtureSeed: 'orchestration-seed',
        normalizedClock: FIXED_CLOCK,
        parentDir,
        runsRoot,
        packInstalledArtifact: ({ fixture }) => {
          packCalls += 1
          return {
            packageName: '@fro.bot/systematic',
            packageVersion: '1.2.3',
            moduleEntry: path.join(fixture.packageRoot, 'dist/index.js'),
            moduleEntryId: 'dist/index.js',
            tarballPath: path.join(fixture.artifactRoot, 'package.tgz'),
            tarballDigest: 'a'.repeat(64),
            packageRoot: fixture.packageRoot,
            packageRootId: 'installed-package-root',
            configEntryId: 'installed-config',
          }
        },
        sourceRunner: async (options) => {
          calls.push(`${options.caseId}/${options.mode}`)
          return syntheticResult({
            caseId: options.caseId,
            mode: 'source',
            runId: options.runId ?? 'run-missing',
            outcome: 'success',
            subcode: 'none',
          })
        },
        installedRunner: async (options) => {
          calls.push(`${options.caseId}/${options.mode}`)
          return syntheticResult({
            caseId: options.caseId,
            mode: 'installed',
            runId: options.runId ?? 'run-missing',
            outcome:
              options.caseId === 'bootstrap-loading'
                ? 'task_failure'
                : 'success',
            subcode:
              options.caseId === 'bootstrap-loading'
                ? 'write_mismatch'
                : 'none',
          })
        },
      })

      expect(packCalls).toBe(1)
      expect(calls).toEqual([
        'bootstrap-loading/installed',
        'bootstrap-loading/source',
        'fixture-local-write/installed',
        'fixture-local-write/source',
      ])
      expect(run.manifest.partial).toBe(false)
      expect(run.results).toHaveLength(4)
      expect(run.results.every((result) => result.runId === run.runId)).toBe(
        true,
      )

      const abortedCalls: string[] = []
      const aborted = await runEvalSelections({
        selectionIds: [
          'bootstrap-loading/source',
          'fixture-local-write/source',
        ],
        fixtureSeed: 'orchestration-abort',
        normalizedClock: FIXED_CLOCK,
        parentDir,
        runsRoot: path.join(parentDir, 'aborted-runs'),
        sourceRunner: async (options) => {
          abortedCalls.push(options.caseId)
          return syntheticResult({
            caseId: options.caseId,
            mode: 'source',
            runId: options.runId ?? 'run-missing',
            outcome: 'infra_failure',
            subcode: 'identity_drift',
          })
        },
      })
      expect(abortedCalls).toEqual(['bootstrap-loading'])
      expect(aborted.manifest.partial).toBe(true)
      expect(aborted.manifest.completedSelectionIds).toEqual([
        'bootstrap-loading/source',
      ])
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('mode-local installed artifact failure still permits independent source selections', async () => {
    const parentDir = runParent()
    try {
      const calls: string[] = []
      const run = await runEvalSelections({
        selectionIds: [
          'bootstrap-loading/installed',
          'fixture-local-write/installed',
          'bootstrap-loading/source',
        ],
        fixtureSeed: 'orchestration-artifact',
        normalizedClock: FIXED_CLOCK,
        parentDir,
        runsRoot: path.join(parentDir, 'runs'),
        packInstalledArtifact: () => {
          throw new Error('eval-artifact:artifact_resolution')
        },
        sourceRunner: async (options) => {
          calls.push(`${options.caseId}/${options.mode}`)
          return syntheticResult({
            caseId: options.caseId,
            mode: 'source',
            runId: options.runId ?? 'run-missing',
            outcome: 'success',
            subcode: 'none',
          })
        },
        installedRunner: async (options) => {
          calls.push(`${options.caseId}/${options.mode}`)
          return syntheticResult({
            caseId: options.caseId,
            mode: 'installed',
            runId: options.runId ?? 'run-missing',
            outcome: 'success',
            subcode: 'none',
          })
        },
      })

      expect(calls).toEqual(['bootstrap-loading/source'])
      expect(run.manifest.partial).toBe(true)
      expect(run.results).toHaveLength(2)
      expect(
        run.results.find((result) => result.mode === 'source')?.outcome,
      ).toBe('success')
      expect(
        run.results.find((result) => result.mode === 'installed')?.subcode,
      ).toBe('artifact_resolution')
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('packing failure after fixture creation persists artifact_resolution and cleans all fixture residue', async () => {
    const parentDir = runParent()
    const runsRoot = path.join(parentDir, 'runs')
    try {
      const run = await runEvalSelections({
        selectionIds: [
          'bootstrap-loading/installed',
          'bootstrap-loading/source',
        ],
        fixtureSeed: 'packing-throws-after-fixture',
        normalizedClock: FIXED_CLOCK,
        parentDir,
        runsRoot,
        packInstalledArtifact: ({ fixture }) => {
          fs.writeFileSync(
            path.join(fixture.artifactRoot, 'packing-started.marker'),
            'started',
          )
          throw new Error('injected packing failure')
        },
        sourceRunner: async (input) =>
          syntheticResult({
            caseId: input.caseId,
            mode: 'source',
            runId: input.runId ?? 'run-missing',
            outcome: 'success',
            subcode: 'none',
          }),
      })

      expect(run.manifest.partial).toBe(false)
      expect(
        run.results.find((result) => result.mode === 'installed'),
      ).toMatchObject({
        outcome: 'infra_failure',
        subcode: 'artifact_resolution',
      })
      expect(
        run.results.find((result) => result.mode === 'source'),
      ).toMatchObject({ outcome: 'success', subcode: 'none' })
      expect(
        validateSerializedRunManifest(
          fs.readFileSync(path.join(runsRoot, run.runId, 'manifest.json')),
        ).partial,
      ).toBe(false)
      expect(
        fs
          .readdirSync(parentDir)
          .filter((entry) => entry.startsWith('systematic-eval')),
      ).toEqual([])
      expect(
        fs
          .readdirSync(parentDir)
          .filter((entry) => entry.startsWith('systematic-eval-quarantine')),
      ).toEqual([])
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('cleans the shared artifact fixture immediately after the final installed selection', async () => {
    const parentDir = runParent()
    const cleanupCalls: string[] = []
    const options = {
      selectionIds: [
        'bootstrap-loading/installed',
        'bootstrap-loading/source',
        'fixture-local-write/installed',
        'fixture-local-write/source',
      ],
      fixtureSeed: 'shared-artifact-cleanup',
      normalizedClock: FIXED_CLOCK,
      parentDir,
      runsRoot: path.join(parentDir, 'runs'),
      packInstalledArtifact: ({ fixture }: { fixture: EvalFixture }) => ({
        packageName: '@fro.bot/systematic',
        packageVersion: '1.2.3',
        moduleEntry: path.join(fixture.packageRoot, 'dist/index.js'),
        moduleEntryId: 'dist/index.js',
        tarballPath: path.join(fixture.artifactRoot, 'package.tgz'),
        tarballDigest: 'a'.repeat(64),
        packageRoot: fixture.packageRoot,
        packageRootId: 'installed-package-root',
        configEntryId: 'installed-config',
      }),
      artifactCleanupHooks: {
        cleanupFixture: (fixture: EvalFixture) => {
          cleanupCalls.push('cleanup')
          fs.rmSync(fixture.runRoot, { recursive: true, force: true })
        },
      },
      sourceRunner: async (input: EvalSelectionRunnerInput) => {
        cleanupCalls.push(`${input.caseId}/${input.mode}`)
        return syntheticResult({
          caseId: input.caseId,
          mode: 'source',
          runId: input.runId ?? 'run-missing',
          outcome: 'success',
          subcode: 'none',
        })
      },
      installedRunner: async (input: EvalSelectionRunnerInput) => {
        cleanupCalls.push(`${input.caseId}/${input.mode}`)
        return syntheticResult({
          caseId: input.caseId,
          mode: 'installed',
          runId: input.runId ?? 'run-missing',
          outcome: 'success',
          subcode: 'none',
        })
      },
    } as Parameters<typeof runEvalSelections>[0] & {
      artifactCleanupHooks: {
        cleanupFixture: (fixture: EvalFixture) => void
      }
    }

    try {
      await runEvalSelections(options)
      expect(cleanupCalls).toEqual([
        'bootstrap-loading/installed',
        'bootstrap-loading/source',
        'fixture-local-write/installed',
        'cleanup',
        'fixture-local-write/source',
      ])
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('persists shared artifact cleanup failures and converts dependent results', async () => {
    const parentDir = runParent()
    const options = {
      selectionIds: [
        'bootstrap-loading/installed',
        'bootstrap-loading/source',
        'fixture-local-write/installed',
        'fixture-local-write/source',
      ],
      fixtureSeed: 'shared-artifact-quarantine',
      normalizedClock: FIXED_CLOCK,
      parentDir,
      runsRoot: path.join(parentDir, 'runs'),
      packInstalledArtifact: ({ fixture }: { fixture: EvalFixture }) => ({
        packageName: '@fro.bot/systematic',
        packageVersion: '1.2.3',
        moduleEntry: path.join(fixture.packageRoot, 'dist/index.js'),
        moduleEntryId: 'dist/index.js',
        tarballPath: path.join(fixture.artifactRoot, 'package.tgz'),
        tarballDigest: 'a'.repeat(64),
        packageRoot: fixture.packageRoot,
        packageRootId: 'installed-package-root',
        configEntryId: 'installed-config',
      }),
      artifactCleanupHooks: {
        cleanupFixture: () => undefined,
        quarantineResidue: (fixture: EvalFixture, quarantineRoot: string) => {
          fs.renameSync(fixture.runRoot, quarantineRoot)
        },
      },
      sourceRunner: async (input: EvalSelectionRunnerInput) =>
        syntheticResult({
          caseId: input.caseId,
          mode: 'source',
          runId: input.runId ?? 'run-missing',
          outcome: 'success',
          subcode: 'none',
        }),
      installedRunner: async (input: EvalSelectionRunnerInput) =>
        syntheticResult({
          caseId: input.caseId,
          mode: 'installed',
          runId: input.runId ?? 'run-missing',
          outcome: 'success',
          subcode: 'none',
        }),
    } as Parameters<typeof runEvalSelections>[0] & {
      artifactCleanupHooks: {
        cleanupFixture: () => void
        quarantineResidue: (
          fixture: EvalFixture,
          quarantineRoot: string,
        ) => void
      }
    }

    try {
      const run = await runEvalSelections(options)
      expect(run.manifest.partial).toBe(false)
      expect(run.results).toHaveLength(4)
      expect(
        run.results
          .filter((result) => result.mode === 'installed')
          .map((result) => [result.outcome, result.subcode, result.cleanup]),
      ).toEqual([
        [
          'privacy_cleanup_failure',
          'residue_detected',
          { status: 'quarantined', residue: 'quarantined' },
        ],
        [
          'privacy_cleanup_failure',
          'residue_detected',
          { status: 'quarantined', residue: 'quarantined' },
        ],
      ])
      expect(
        run.results.find((result) => result.mode === 'source')?.outcome,
      ).toBe('success')
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('quarantine failure aborts later selections after persisting dependent privacy failures', async () => {
    const parentDir = runParent()
    const calls: string[] = []
    const options = {
      selectionIds: [
        'bootstrap-loading/installed',
        'bootstrap-loading/source',
        'fixture-local-write/installed',
        'fixture-local-write/source',
      ],
      fixtureSeed: 'shared-artifact-quarantine-failure',
      normalizedClock: FIXED_CLOCK,
      parentDir,
      runsRoot: path.join(parentDir, 'runs'),
      packInstalledArtifact: ({ fixture }: { fixture: EvalFixture }) => ({
        packageName: '@fro.bot/systematic',
        packageVersion: '1.2.3',
        moduleEntry: path.join(fixture.packageRoot, 'dist/index.js'),
        moduleEntryId: 'dist/index.js',
        tarballPath: path.join(fixture.artifactRoot, 'package.tgz'),
        tarballDigest: 'a'.repeat(64),
        packageRoot: fixture.packageRoot,
        packageRootId: 'installed-package-root',
        configEntryId: 'installed-config',
      }),
      artifactCleanupHooks: {
        cleanupFixture: () => undefined,
        quarantineResidue: () => {
          throw new Error('injected shared quarantine failure')
        },
      },
      sourceRunner: async (input: EvalSelectionRunnerInput) => {
        calls.push(`${input.caseId}/${input.mode}`)
        return syntheticResult({
          caseId: input.caseId,
          mode: 'source',
          runId: input.runId ?? 'run-missing',
          outcome: 'success',
          subcode: 'none',
        })
      },
      installedRunner: async (input: EvalSelectionRunnerInput) => {
        calls.push(`${input.caseId}/${input.mode}`)
        return syntheticResult({
          caseId: input.caseId,
          mode: 'installed',
          runId: input.runId ?? 'run-missing',
          outcome: 'success',
          subcode: 'none',
        })
      },
    } as Parameters<typeof runEvalSelections>[0] & {
      artifactCleanupHooks: {
        cleanupFixture: () => void
        quarantineResidue: () => never
      }
    }

    try {
      const run = await runEvalSelections(options)
      expect(calls).toEqual([
        'bootstrap-loading/installed',
        'bootstrap-loading/source',
        'fixture-local-write/installed',
      ])
      expect(run.manifest.partial).toBe(true)
      expect(run.results).toHaveLength(3)
      expect(
        run.results
          .filter((result) => result.mode === 'installed')
          .every(
            (result) =>
              result.outcome === 'privacy_cleanup_failure' &&
              result.subcode === 'quarantine_failed',
          ),
      ).toBe(true)
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('persists bounded infrastructure results with exit 1 and no path leakage', async () => {
    const parentDir = runParent()
    try {
      const result = await runEvalCli(
        [
          '--case',
          'bootstrap-loading',
          '--mode',
          'source',
          '--seed',
          'cli-infra-seed',
          '--clock',
          FIXED_CLOCK,
        ],
        {
          parentDir,
          runsRoot: path.join(parentDir, 'runs'),
          sourceRunner: async (input) => ({
            ...boundedInfraResult(),
            runId: input.runId ?? 'run-infra',
            fixtureSeed: input.fixtureSeed,
            normalizedClock: input.normalizedClock,
          }),
        },
      )

      expect(result.kind).toBe('run')
      if (result.kind !== 'run') throw new Error('expected persisted run')
      expect(result.exitCode).toBe(1)
      expect(result.run.manifest.partial).toBe(false)
      const persistedRoot = path.join(parentDir, 'runs', result.run.runId)
      const manifest = validateSerializedRunManifest(
        fs.readFileSync(path.join(persistedRoot, 'manifest.json')),
      )
      const persistedResult = validateSerializedResult(
        fs.readFileSync(
          path.join(persistedRoot, 'results/bootstrap-loading/source.json'),
        ),
      )
      expect(manifest.partial).toBe(false)
      expect(persistedResult.outcome).toBe('infra_failure')
      expect(JSON.stringify(result)).not.toContain(parentDir)
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('repeated frozen source and installed selection runs have equal normalized results and manifests', async () => {
    const firstParent = runParent()
    const secondParent = runParent()
    const selectionIds = [
      'bootstrap-loading/installed',
      'bootstrap-loading/source',
      'fixture-local-write/installed',
      'fixture-local-write/source',
    ]
    const buildOptions = (parentDir: string) => ({
      selectionIds,
      fixtureSeed: 'frozen-selection-seed',
      normalizedClock: FIXED_CLOCK,
      parentDir,
      runsRoot: path.join(parentDir, 'runs'),
      packInstalledArtifact: ({ fixture }: { fixture: EvalFixture }) => ({
        packageName: '@fro.bot/systematic',
        packageVersion: '1.2.3',
        moduleEntry: path.join(fixture.packageRoot, 'dist/index.js'),
        moduleEntryId: 'dist/index.js',
        tarballPath: path.join(fixture.artifactRoot, 'package.tgz'),
        tarballDigest: 'a'.repeat(64),
        packageRoot: fixture.packageRoot,
        packageRootId: 'installed-package-root',
        configEntryId: 'installed-config',
      }),
      sourceRunner: async (input: EvalSelectionRunnerInput) =>
        syntheticResult({
          caseId: input.caseId,
          mode: 'source',
          runId: input.runId ?? 'run-missing',
          outcome: 'success',
          subcode: 'none',
        }),
      installedRunner: async (input: EvalSelectionRunnerInput) =>
        syntheticResult({
          caseId: input.caseId,
          mode: 'installed',
          runId: input.runId ?? 'run-missing',
          outcome: 'success',
          subcode: 'none',
        }),
    })

    try {
      const first = await runEvalSelections(buildOptions(firstParent))
      const second = await runEvalSelections(buildOptions(secondParent))
      expect(
        normalizeRunIdentity(
          { manifest: first.manifest, results: first.results },
          [first.runId, second.runId],
        ),
      ).toEqual(
        normalizeRunIdentity(
          { manifest: second.manifest, results: second.results },
          [first.runId, second.runId],
        ),
      )
    } finally {
      fs.rmSync(firstParent, { recursive: true, force: true })
      fs.rmSync(secondParent, { recursive: true, force: true })
    }
  })

  test('CLI returns exact help, argument, and failing-run exit codes', async () => {
    const help = await runEvalCli(['--help'])
    expect(help).toEqual({
      kind: 'help',
      exitCode: 0,
      usage: EXPECTED_CLI_HELP,
    })

    const argumentError = await runEvalCli(['--unknown'])
    expect(argumentError).toMatchObject({
      kind: 'error',
      exitCode: 2,
      usage: EXPECTED_CLI_HELP,
    })

    const parentDir = runParent()
    try {
      const failed = await runEvalCli(
        [
          '--case',
          'bootstrap-loading',
          '--mode',
          'source',
          '--seed',
          'cli-failing-seed',
          '--clock',
          FIXED_CLOCK,
        ],
        {
          parentDir,
          runsRoot: path.join(parentDir, 'runs'),
          sourceRunner: async (options) =>
            syntheticResult({
              caseId: options.caseId,
              mode: 'source',
              runId: options.runId ?? 'run-missing',
              outcome: 'task_failure',
              subcode: 'write_mismatch',
            }),
        },
      )

      expect(failed).toMatchObject({ kind: 'run', exitCode: 1 })
      expect(JSON.stringify(failed)).not.toContain(parentDir)
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('direct CLI argument errors are one concise JSON object', async () => {
    const rootDir = path.resolve(import.meta.dirname, '../..')
    const child = spawn(
      process.execPath,
      ['scripts/run-evals.ts', '--unknown'],
      { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const [exitCode] = (await once(child, 'exit')) as [number | null]
    expect(exitCode).toBe(2)
    expect(stdout).toBe('')
    const lines = stderr.trim().split(/\r?\n/)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      status: 'error',
      exitCode: 2,
      code: 'eval-cli:unknown_argument',
      usage: EXPECTED_CLI_HELP,
    })
  })

  // Spawns the real CLI, which starts a real OpenCode host; gated like the
  // other real-eval tests so it skips offline instead of hard-failing on
  // exitCode/outcome !== success.
  test.skipIf(!OPENCODE_AVAILABLE)(
    'source direct CLI success emits one JSON object and validator-parseable artifacts',
    async () => {
      const rootDir = path.resolve(import.meta.dirname, '../..')
      const child = spawn(
        process.execPath,
        [
          'scripts/run-evals.ts',
          '--case',
          'bootstrap-loading',
          '--mode',
          'source',
          '--seed',
          'direct-cli-success',
          '--clock',
          FIXED_CLOCK,
        ],
        { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      const [exitCode] = (await once(child, 'exit')) as [number | null]
      expect(exitCode).toBe(0)
      expect(stderr).toBe('')
      const lines = stdout.trim().split(/\r?\n/)
      expect(lines).toHaveLength(1)
      const summary = JSON.parse(lines[0] ?? '') as {
        status: string
        exitCode: number
        runId: string
        manifestArtifactId: string
      }
      expect(summary).toMatchObject({
        status: 'written',
        exitCode: 0,
        manifestArtifactId: `evals/runs/${summary.runId}/manifest.json`,
      })

      const runRoot = path.join(rootDir, 'evals/runs', summary.runId)
      try {
        expect(
          validateSerializedRunManifest(
            fs.readFileSync(path.join(runRoot, 'manifest.json')),
          ).partial,
        ).toBe(false)
        expect(
          validateSerializedResult(
            fs.readFileSync(
              path.join(runRoot, 'results/bootstrap-loading/source.json'),
            ),
          ).outcome,
        ).toBe('success')
      } finally {
        fs.rmSync(runRoot, { recursive: true, force: true })
      }
    },
    360_000,
  )

  test('direct CLI interruption cleans started children and run-owned roots', async () => {
    const parentDir = runParent()
    const markerPath = path.join(parentDir, 'started-child.marker')
    const rootDir = path.resolve(import.meta.dirname, '../..')
    const beforeServeProcesses = countEvalServeProcesses()
    const child = spawn(
      process.execPath,
      [
        'scripts/run-evals.ts',
        '--case',
        'bootstrap-loading',
        '--mode',
        'source',
        '--seed',
        'direct-cli-interrupt',
        '--clock',
        FIXED_CLOCK,
      ],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          TMPDIR: parentDir,
          SYSTEMATIC_EVAL_STARTED_CHILD_MARKER: markerPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    try {
      await waitForMarker(markerPath, 360_000)
      child.kill('SIGINT')
      const [exitCode] = (await once(child, 'exit')) as [number | null]
      expect(exitCode).not.toBe(0)
      expect(stderr).toBe('')
      const lines = stdout.trim().split(/\r?\n/)
      expect(lines).toHaveLength(1)
      const summary = JSON.parse(lines[0] ?? '') as {
        status: string
        exitCode: number
        runId?: string
      }
      expect(summary.exitCode).toBe(1)
      expect(summary.status).toBe('interrupted')
      expect(
        fs
          .readdirSync(parentDir)
          .filter(
            (entry) =>
              entry.startsWith('systematic-eval') ||
              entry.startsWith('systematic-eval-quarantine'),
          ),
      ).toEqual([])
      expect(countEvalServeProcesses()).toBe(beforeServeProcesses)
      if (summary.runId) {
        fs.rmSync(path.join(rootDir, 'evals/runs', summary.runId), {
          recursive: true,
          force: true,
        })
      }
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  }, 360_000)

  test('signal cleanup uses registered hooks and quarantines residue before returning', async () => {
    const parentDir = runParent()
    const events: string[] = []
    const previousExitCode = process.exitCode
    const removeSignalHandlers = installEvalSignalHandlers()
    try {
      const result = normalizeResult(
        await runSourceEval({
          caseId: 'bootstrap-loading',
          fixtureSeed: 'signal-hook-cleanup',
          normalizedClock: FIXED_CLOCK,
          parentDir,
          lifecycleHooks: {
            executeCase: async () => {
              process.emit('SIGINT')
              return syntheticExecution('success', 'none')
            },
            cleanupFixture: () => {
              events.push('cleanup')
            },
            quarantineResidue: (fixture, quarantineRoot) => {
              events.push('quarantine')
              fs.renameSync(fixture.runRoot, quarantineRoot)
            },
          },
        }),
      )

      expect(result.outcome).toBe('privacy_cleanup_failure')
      expect(result.cleanup).toEqual({
        status: 'quarantined',
        residue: 'quarantined',
      })
      expect(events).toEqual(['cleanup', 'quarantine'])
      expect(
        fs
          .readdirSync(parentDir)
          .filter((entry) => entry.startsWith('systematic-eval-')),
      ).toHaveLength(1)
    } finally {
      removeSignalHandlers()
      process.exitCode = previousExitCode ?? 0
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })
})
