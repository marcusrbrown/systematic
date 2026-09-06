import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { validateModelInheritanceManifest } from '../../scripts/eval-cases/opencode.ts'
import { readOpencodeDevDependencyPins } from '../../scripts/lib/opencode-pin.ts'
import {
  CASE_IDS,
  CASE_SCHEMA_VERSION,
  type EvalMode,
  normalizeResult,
  OUTCOMES,
  parseCaseManifest,
  RESULT_SCHEMA_VERSION,
  serializeResult,
} from '../../scripts/run-evals.ts'
import { buildBundledAgentInventory } from '../../src/lib/agent-overlays.js'
import { buildCatalogEntries } from '../../src/lib/skill-catalog.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const MANIFEST_DIR = path.join(ROOT_DIR, 'evals/cases/opencode')

function readManifest(fileName: string): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(MANIFEST_DIR, fileName), 'utf8'),
  ) as unknown
}

function sourceProvenance(): Record<string, unknown> {
  return {
    kind: 'source',
    checkoutRelativeSource: 'src/index.ts',
    commitId: 'a'.repeat(40),
    worktreeId: 'worktree-1',
    canonicalSourceEntryId: 'source-entry',
    opencodeConfigEntryId: 'source-config',
  }
}

function installedProvenance(): Record<string, unknown> {
  return {
    kind: 'installed',
    packageName: '@fro.bot/systematic',
    packageVersion: '1.2.3',
    tarballDigest: 'b'.repeat(64),
    extractedPackageRootId: 'package-root-1',
    canonicalResolvedModuleEntryId: 'dist/index.js',
    opencodeConfigEntryId: 'installed-config',
  }
}

function validResult(mode: EvalMode = 'source'): Record<string, unknown> {
  const fixtureAssertions = ['fixture-file-content', 'fixture-file-created']
  return {
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    caseSchemaVersion: CASE_SCHEMA_VERSION,
    caseId: 'fixture-local-write',
    harness: 'opencode',
    mode,
    outcome: 'success',
    subcode: 'none',
    runId: 'run-001',
    fixtureSeed: 'fixture-seed-001',
    normalizedClock: '2026-08-13T00:00:00.000Z',
    assertionIds: fixtureAssertions,
    identity: {
      opencodeVersion: '1.18.16',
      opencodeBuildId: 'build-001',
      probeId: 'probe-opencode-v1',
      probeDigest: 'c'.repeat(64),
      fixtureContractVersion: 1,
      fixtureContractDigest: 'd'.repeat(64),
      caseSchemaVersion: CASE_SCHEMA_VERSION,
      resultSchemaVersion: RESULT_SCHEMA_VERSION,
      artifactId: mode === 'source' ? 'source-entry' : 'installed-entry',
      artifactDigest: 'e'.repeat(64),
    },
    evidence: {
      sanity: 'passed',
      process: 'completed',
      assertionIds: fixtureAssertions,
    },
    cleanup: {
      status: 'clean',
      residue: 'none',
    },
    privacy: {
      status: 'validated',
    },
    artifactRefs: ['artifacts/result.json', 'probe/health.json'],
    provenance: mode === 'source' ? sourceProvenance() : installedProvenance(),
  }
}

function validModelInheritanceResult(
  mode: EvalMode = 'source',
): Record<string, unknown> {
  const assertionIds = [
    'agents-inherit-invoking-model',
    'explicit-model-overlay-wins',
    'model-null-restores-inheritance',
    'project-model-trust-boundary',
  ]
  return {
    ...validResult(mode),
    caseId: 'model-inheritance',
    assertionIds,
    identity: {
      ...(validResult(mode).identity as Record<string, unknown>),
      artifactId: mode === 'source' ? 'source-entry' : 'installed-entry',
    },
    evidence: {
      sanity: 'passed',
      process: 'completed',
      assertionIds,
      modelInheritance: [
        {
          availability: 'known',
          policy: 'none',
          agents: [
            {
              agentId: 'review/correctness-reviewer',
              modelPresent: false,
              variantPresent: false,
            },
          ],
        },
      ],
    },
  }
}

describe('local OpenCode eval contracts', () => {
  test('exposes exactly four cases, four outcomes, and the supported schema versions', () => {
    expect(CASE_IDS).toEqual([
      'bootstrap-loading',
      'fixture-local-write',
      'host-skill-coverage',
      'model-inheritance',
    ])
    expect(OUTCOMES).toEqual([
      'success',
      'infra_failure',
      'task_failure',
      'privacy_cleanup_failure',
    ])
    expect(CASE_SCHEMA_VERSION).toBe(1)
    expect(RESULT_SCHEMA_VERSION).toBe(1)
  })

  test('accepts the host-skill-coverage case manifest with raw bundled skill names', () => {
    expect(
      parseCaseManifest({
        caseSchemaVersion: 1,
        caseId: 'host-skill-coverage',
        harness: 'opencode',
        assertionIds: ['host-catalog-covered'],
        expectedSkillNames: ['agent-browser', 'ce:brainstorm'],
      }),
    ).toEqual({
      caseSchemaVersion: 1,
      caseId: 'host-skill-coverage',
      harness: 'opencode',
      assertionIds: ['host-catalog-covered'],
      expectedSkillNames: ['agent-browser', 'ce:brainstorm'],
    })
  })

  test('accepts the model-inheritance case manifest with every bundled agent', () => {
    const manifest = parseCaseManifest(readManifest('model-inheritance.json'))
    expect(manifest).toMatchObject({
      caseSchemaVersion: 1,
      caseId: 'model-inheritance',
      harness: 'opencode',
      assertionIds: [
        'agents-inherit-invoking-model',
        'explicit-model-overlay-wins',
        'model-null-restores-inheritance',
        'project-model-trust-boundary',
      ],
      category: 'review',
      categoryModel: 'systematic-eval-category-model',
      categoryVariant: 'systematic-eval-category-variant',
      exactAgentId: 'review/correctness-reviewer',
      exactModel: 'systematic-eval-exact-model',
      exactVariant: 'systematic-eval-exact-variant',
    })
    if (manifest.caseId !== 'model-inheritance') {
      throw new Error('expected model-inheritance manifest')
    }

    const inventory = buildBundledAgentInventory(
      path.join(ROOT_DIR, 'agents'),
      [],
    )
    expect(manifest.expectedAgentIds).toEqual(
      Object.keys(inventory.agentsByQualifiedId).sort(),
    )
    expect(
      new Set(manifest.expectedAgentIds.map((id) => id.split('/')[0])),
    ).toEqual(
      new Set(['design', 'document-review', 'research', 'review', 'workflow']),
    )

    const crafted = {
      ...manifest,
      expectedAgentIds: [...manifest.expectedAgentIds, 'review/attacker-agent'],
    }
    expect(() => validateModelInheritanceManifest(crafted)).toThrow()
  })

  test('accepts all declarative case manifests', () => {
    const bootstrap = parseCaseManifest(readManifest('bootstrap-loading.json'))
    const fixture = parseCaseManifest(readManifest('fixture-local-write.json'))
    const hostCoverage = parseCaseManifest(
      readManifest('host-skill-coverage.json'),
    )
    const modelInheritance = parseCaseManifest(
      readManifest('model-inheritance.json'),
    )

    expect(bootstrap).toEqual({
      caseSchemaVersion: 1,
      caseId: 'bootstrap-loading',
      harness: 'opencode',
      assertionIds: ['bootstrap-observed'],
    })
    expect(fixture).toEqual({
      caseSchemaVersion: 1,
      caseId: 'fixture-local-write',
      harness: 'opencode',
      assertionIds: ['fixture-file-content', 'fixture-file-created'],
      expectedArtifactId: 'fixture/output.txt',
      expectedContentId: 'fixture-local-write-v1',
    })
    expect(hostCoverage).toMatchObject({
      caseSchemaVersion: 1,
      caseId: 'host-skill-coverage',
      harness: 'opencode',
      assertionIds: ['host-catalog-covered'],
    })
    expect(modelInheritance).toMatchObject({
      caseSchemaVersion: 1,
      caseId: 'model-inheritance',
      harness: 'opencode',
    })
  })

  test('keeps host coverage manifest names exactly in sync with the live bundled catalog', () => {
    const hostCoverage = parseCaseManifest(
      readManifest('host-skill-coverage.json'),
    )
    if (hostCoverage.caseId !== 'host-skill-coverage') {
      throw new Error('expected host-skill-coverage manifest')
    }

    const bundledSkillNames = buildCatalogEntries({
      bundledSkillsDir: path.join(ROOT_DIR, 'skills'),
      disabledSkills: [],
    }).map((entry) => entry.name)
    const manifestSkillNames = hostCoverage.expectedSkillNames
    const missingFromManifest = bundledSkillNames.filter(
      (name) => !manifestSkillNames.includes(name),
    )
    const staleManifestNames = manifestSkillNames.filter(
      (name) => !bundledSkillNames.includes(name),
    )

    if (missingFromManifest.length > 0 || staleManifestNames.length > 0) {
      throw new Error(
        [
          'host-skill-coverage manifest drift detected.',
          `Add bundled skills missing from the manifest: ${missingFromManifest.join(', ') || 'none'}.`,
          `Remove manifest skills absent from the bundled catalog: ${staleManifestNames.join(', ') || 'none'}.`,
        ].join(' '),
      )
    }

    expect(missingFromManifest).toEqual([])
    expect(staleManifestNames).toEqual([])
  })

  test('keeps @opencode-ai/sdk and @opencode-ai/plugin devDependencies aligned', () => {
    const { sdk: sdkVersion, plugin: pluginVersion } =
      readOpencodeDevDependencyPins()

    if (sdkVersion !== pluginVersion) {
      throw new Error(
        `OpenCode devDependency versions disagree: @opencode-ai/sdk is ${sdkVersion}, but @opencode-ai/plugin is ${pluginVersion}. Align both dependencies before re-running the host-coverage eval.`,
      )
    }

    expect(sdkVersion).toBe(pluginVersion)
  })

  test('rejects unknown, missing, unsupported, and wrong-version manifest fields', () => {
    const valid = readManifest('bootstrap-loading.json') as Record<
      string,
      unknown
    >

    expect(() =>
      parseCaseManifest({ ...valid, prompt: 'not executable prose' }),
    ).toThrow()

    const missing = { ...valid }
    delete missing.assertionIds
    expect(() => parseCaseManifest(missing)).toThrow()

    expect(() =>
      parseCaseManifest({ ...valid, caseId: 'third-case' }),
    ).toThrow()
    expect(() =>
      parseCaseManifest({ ...valid, caseSchemaVersion: 2 }),
    ).toThrow()
    expect(() =>
      parseCaseManifest({ ...valid, harness: 'other-harness' }),
    ).toThrow()
  })

  test('accepts every primary outcome only with its bounded subcodes', () => {
    const cases = [
      ['success', 'none'],
      ['infra_failure', 'identity_drift'],
      ['task_failure', 'write_mismatch'],
      ['privacy_cleanup_failure', 'redaction_failed'],
    ] as const

    for (const [outcome, subcode] of cases) {
      const result = normalizeResult({
        ...validResult(),
        outcome,
        subcode,
      })
      expect(result.outcome).toBe(outcome)
      expect(result.subcode).toBe(subcode)
    }
  })

  test('rejects fifth outcomes and invalid outcome/subcode pairings', () => {
    for (const [outcome, subcode] of [
      ['success', 'identity_drift'],
      ['infra_failure', 'write_mismatch'],
      ['task_failure', 'redaction_failed'],
      ['privacy_cleanup_failure', 'bootstrap_not_observed'],
      ['not_an_outcome', 'none'],
    ]) {
      expect(() =>
        normalizeResult({ ...validResult(), outcome, subcode }),
      ).toThrow()
    }
  })

  test('keeps source and installed provenance disjoint and complete', () => {
    expect(normalizeResult(validResult('source')).provenance).toMatchObject({
      kind: 'source',
    })
    expect(normalizeResult(validResult('installed')).provenance).toMatchObject({
      kind: 'installed',
    })

    expect(() =>
      normalizeResult({
        ...validResult('source'),
        provenance: installedProvenance(),
      }),
    ).toThrow()
    expect(() =>
      normalizeResult({
        ...validResult('installed'),
        provenance: sourceProvenance(),
      }),
    ).toThrow()

    const incomplete = sourceProvenance()
    delete incomplete.canonicalSourceEntryId
    expect(() =>
      normalizeResult({ ...validResult('source'), provenance: incomplete }),
    ).toThrow()
  })

  test('canonicalizes keys and collections deterministically', () => {
    const first = validResult()
    const second = validResult()
    second.assertionIds = ['fixture-file-created', 'fixture-file-content']
    second.evidence = {
      assertionIds: ['fixture-file-created', 'fixture-file-content'],
      process: 'completed',
      sanity: 'passed',
    }
    second.artifactRefs = ['probe/health.json', 'artifacts/result.json']

    expect(serializeResult(first)).toBe(serializeResult(second))
    expect(JSON.parse(serializeResult(first))).toEqual(normalizeResult(first))
  })

  test('round-trips bounded prompt composition observations without prompt text', () => {
    const promptComposition = {
      bootstrapPayloadSize: 18_145,
      systematicCatalog: {
        state: 'present',
        entryCount: 23,
        skillNames: ['systematic:alpha', 'systematic:beta'],
      },
      hostCatalog: {
        state: 'absent',
        entryCount: 0,
        skillNames: [],
      },
    }
    const candidate = {
      ...validResult(),
      evidence: {
        sanity: 'passed',
        process: 'completed',
        assertionIds: ['fixture-file-content', 'fixture-file-created'],
        promptComposition,
      },
    }

    expect(normalizeResult(candidate).evidence.promptComposition).toEqual(
      promptComposition,
    )
    expect(
      JSON.parse(serializeResult(candidate)).evidence.promptComposition,
    ).toEqual(promptComposition)
  })

  test('keeps present, absent, and impossible prompt observations distinct', () => {
    const states = ['present', 'absent', 'impossible'] as const

    for (const state of states) {
      const promptComposition = {
        bootstrapPayloadSize: state === 'impossible' ? 0 : 128,
        systematicCatalog: {
          state,
          entryCount: state === 'present' ? 1 : 0,
          skillNames: state === 'present' ? ['systematic:alpha'] : [],
        },
        hostCatalog: {
          state: 'absent' as const,
          entryCount: 0,
          skillNames: [],
        },
      }

      expect(
        normalizeResult({
          ...validResult(),
          evidence: {
            sanity: 'passed',
            process: 'completed',
            assertionIds: ['fixture-file-content', 'fixture-file-created'],
            promptComposition,
          },
        }).evidence.promptComposition?.systematicCatalog.state,
      ).toBe(state)
    }
  })

  test('rejects raw prompt fields before result serialization', () => {
    expect(() =>
      serializeResult({
        ...validResult(),
        evidence: {
          sanity: 'passed',
          process: 'completed',
          assertionIds: ['fixture-file-content', 'fixture-file-created'],
          prompt: 'raw system prompt text',
        },
      }),
    ).toThrow()
  })

  test('persists only structural model-inheritance facts', () => {
    const candidate = validModelInheritanceResult()
    const normalized = normalizeResult(candidate)
    expect(normalized.evidence.modelInheritance).toEqual([
      {
        availability: 'known',
        policy: 'none',
        agents: [
          {
            agentId: 'review/correctness-reviewer',
            modelPresent: false,
            variantPresent: false,
          },
        ],
      },
    ])

    expect(() =>
      serializeResult({
        ...candidate,
        evidence: {
          ...candidate.evidence,
          modelInheritance: [
            {
              availability: 'known',
              policy: 'none',
              agents: [
                {
                  agentId: 'review/correctness-reviewer',
                  modelPresent: false,
                  variantPresent: false,
                },
              ],
              config: { absolutePath: '/private/config.json' },
            },
          ],
        },
      }),
    ).toThrow()

    expect(() =>
      serializeResult({
        ...candidate,
        evidence: {
          ...candidate.evidence,
          modelInheritance: [
            {
              availability: 'known',
              policy: 'none',
              agents: [
                {
                  agentId: 'review/correctness-reviewer',
                  modelPresent: false,
                  variantPresent: false,
                  model: 'source-owned/provider-model',
                },
              ],
            },
          ],
        },
      }),
    ).toThrow()
  })

  test('round-trips explicit model and variant overlay facts', () => {
    const candidate = validModelInheritanceResult()
    candidate.evidence = {
      ...candidate.evidence,
      modelInheritance: [
        {
          availability: 'known',
          policy: 'exact',
          agents: [
            {
              agentId: 'review/correctness-reviewer',
              modelPresent: true,
              variantPresent: true,
              model: 'systematic-eval-exact-model',
              variant: 'systematic-eval-exact-variant',
            },
          ],
        },
      ],
    }
    expect(normalizeResult(candidate).evidence.modelInheritance).toEqual(
      candidate.evidence.modelInheritance,
    )
  })

  test('binds model-inheritance evidence to its case and requires it there', () => {
    const modelEvidence = {
      ...validModelInheritanceResult().evidence,
      assertionIds: ['fixture-file-content', 'fixture-file-created'],
    }
    expect(() =>
      normalizeResult({
        ...validResult(),
        evidence: modelEvidence,
      }),
    ).toThrow()

    const missingEvidence = validModelInheritanceResult()
    missingEvidence.evidence = {
      sanity: 'passed',
      process: 'completed',
      assertionIds: [
        'agents-inherit-invoking-model',
        'explicit-model-overlay-wins',
        'model-null-restores-inheritance',
        'project-model-trust-boundary',
      ],
    }
    expect(() => normalizeResult(missingEvidence)).toThrow()
  })

  test('round-trips host catalog coverage evidence and rejects an incorrect missing set', () => {
    const hostCatalogCoverage = {
      state: 'present',
      expectedSkillNames: ['agent-browser', 'ce:brainstorm'],
      observedSkillNames: ['agent-browser', 'ce:brainstorm', 'extra-skill'],
      missingSkillNames: [],
    }
    const candidate = {
      ...validResult(),
      evidence: {
        sanity: 'passed',
        process: 'completed',
        assertionIds: ['fixture-file-content', 'fixture-file-created'],
        hostCatalogCoverage,
      },
    }

    expect(normalizeResult(candidate).evidence.hostCatalogCoverage).toEqual(
      hostCatalogCoverage,
    )
    expect(
      JSON.parse(serializeResult(candidate)).evidence.hostCatalogCoverage,
    ).toEqual(hostCatalogCoverage)
    expect(() =>
      normalizeResult({
        ...candidate,
        evidence: {
          ...candidate.evidence,
          hostCatalogCoverage: {
            ...hostCatalogCoverage,
            missingSkillNames: ['agent-browser'],
          },
        },
      }),
    ).toThrow()

    const impossibleCoverage = {
      state: 'impossible',
      expectedSkillNames: ['agent-browser', 'ce:brainstorm'],
      observedSkillNames: [],
      missingSkillNames: [],
    }
    expect(
      normalizeResult({
        ...validResult(),
        outcome: 'infra_failure',
        subcode: 'probe_unhealthy',
        evidence: {
          sanity: 'failed',
          process: 'failed',
          assertionIds: ['fixture-file-content', 'fixture-file-created'],
          hostCatalogCoverage: impossibleCoverage,
        },
      }).evidence.hostCatalogCoverage,
    ).toEqual(impossibleCoverage)
  })
})
