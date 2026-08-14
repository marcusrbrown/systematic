import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertSerializedTextSafe,
  BANNED_FIELD_NAMES,
  normalizeResult,
  normalizeRunManifest,
  parseEvalCliArgs,
  persistEvalRun,
  serializeResult,
  serializeRunManifest,
  validateSerializedResult,
} from '../../scripts/run-evals.ts'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const FIXED_CLOCK = '2026-08-13T00:00:00.000Z'

function rejectionMessage(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected rejection')
}

function validResult(): Record<string, unknown> {
  return {
    resultSchemaVersion: 1,
    caseSchemaVersion: 1,
    caseId: 'bootstrap-loading',
    harness: 'opencode',
    mode: 'source',
    outcome: 'success',
    subcode: 'none',
    runId: 'run-002',
    fixtureSeed: 'fixture-seed-002',
    normalizedClock: '2026-08-13T00:00:00.000Z',
    assertionIds: ['bootstrap-observed'],
    identity: {
      opencodeVersion: '1.18.16',
      opencodeBuildId: 'build-002',
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
      sanity: 'passed',
      process: 'completed',
      assertionIds: ['bootstrap-observed'],
    },
    cleanup: { status: 'clean', residue: 'none' },
    privacy: { status: 'validated' },
    artifactRefs: ['artifacts/result.json'],
    provenance: {
      kind: 'source',
      checkoutRelativeSource: 'src/index.ts',
      commitId: 'd'.repeat(40),
      worktreeId: 'worktree-2',
      canonicalSourceEntryId: 'source-entry',
      opencodeConfigEntryId: 'source-config',
    },
  }
}

function validRunManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    manifestSchemaVersion: 1,
    harness: 'opencode',
    runId: 'run-002',
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
    ...overrides,
  }
}

function tempRunParent(): string {
  return fs.mkdtempSync(path.join(ROOT_DIR, '.tmp-eval-redaction-'))
}

describe('local OpenCode eval redaction and serialization', () => {
  test('parses closed CLI selections and builds sorted deduplicated Cartesian IDs', () => {
    expect(
      parseEvalCliArgs([
        '--mode',
        'source',
        '--case',
        'fixture-local-write',
        '--case',
        'bootstrap-loading',
        '--case',
        'bootstrap-loading',
        '--mode',
        'installed',
        '--mode',
        'source',
        '--seed',
        'fixture-seed-001',
        '--clock',
        FIXED_CLOCK,
      ]),
    ).toEqual({
      cases: ['bootstrap-loading', 'fixture-local-write'],
      modes: ['installed', 'source'],
      fixtureSeed: 'fixture-seed-001',
      normalizedClock: FIXED_CLOCK,
      selectionIds: [
        'bootstrap-loading/installed',
        'bootstrap-loading/source',
        'fixture-local-write/installed',
        'fixture-local-write/source',
      ],
    })
  })

  test('rejects unknown, missing, duplicate singleton, and conflicting CLI arguments', () => {
    const validArgs = [
      '--case',
      'bootstrap-loading',
      '--mode',
      'source',
      '--seed',
      'fixture-seed-001',
      '--clock',
      FIXED_CLOCK,
    ]

    for (const args of [
      ['--unknown', ...validArgs],
      ['--case', 'all', ...validArgs.slice(2)],
      ['--case', ...validArgs.slice(2)],
      ['--mode', ...validArgs.slice(2)],
      [...validArgs, '--seed', 'another-seed'],
      [...validArgs, '--clock', FIXED_CLOCK],
      ['--help', ...validArgs],
    ]) {
      expect(() => parseEvalCliArgs(args)).toThrow()
    }

    expect(() =>
      parseEvalCliArgs([
        '--case',
        'bootstrap-loading',
        '--mode',
        'source',
        '--seed',
        'ghp_fake_github_token_123',
        '--clock',
        FIXED_CLOCK,
      ]),
    ).toThrow()
  })

  test('normalizes the closed run manifest and rejects unknown fields or states', () => {
    const reversed = validRunManifest({
      requestedSelectionIds: [
        'fixture-local-write/source',
        'bootstrap-loading/source',
      ],
      completedSelectionIds: [
        'fixture-local-write/source',
        'bootstrap-loading/source',
      ],
      results: [
        {
          selectionId: 'fixture-local-write/source',
          resultArtifactId: 'results/fixture-local-write/source.json',
          outcome: 'infra_failure',
          subcode: 'opencode_unavailable',
        },
        {
          selectionId: 'bootstrap-loading/source',
          resultArtifactId: 'results/bootstrap-loading/source.json',
          outcome: 'success',
          subcode: 'none',
        },
      ],
    })

    expect(normalizeRunManifest(reversed)).toEqual({
      manifestSchemaVersion: 1,
      harness: 'opencode',
      runId: 'run-002',
      requestedSelectionIds: [
        'bootstrap-loading/source',
        'fixture-local-write/source',
      ],
      completedSelectionIds: [
        'bootstrap-loading/source',
        'fixture-local-write/source',
      ],
      partial: false,
      results: [
        {
          selectionId: 'bootstrap-loading/source',
          resultArtifactId: 'results/bootstrap-loading/source.json',
          outcome: 'success',
          subcode: 'none',
        },
        {
          selectionId: 'fixture-local-write/source',
          resultArtifactId: 'results/fixture-local-write/source.json',
          outcome: 'infra_failure',
          subcode: 'opencode_unavailable',
        },
      ],
    })
    expect(serializeRunManifest(reversed)).toBe(
      serializeRunManifest(normalizeRunManifest(reversed)),
    )

    for (const invalid of [
      { ...validRunManifest(), extra: true },
      { ...validRunManifest(), partial: true },
      { ...validRunManifest(), completedSelectionIds: [] },
      {
        ...validRunManifest(),
        results: [
          {
            selectionId: 'bootstrap-loading/source',
            resultArtifactId: '../escape.json',
            outcome: 'success',
            subcode: 'none',
          },
        ],
      },
      {
        ...validRunManifest(),
        results: [
          {
            selectionId: 'bootstrap-loading/source',
            resultArtifactId: 'results/bootstrap-loading/source.json',
            outcome: 'success',
            subcode: 'identity_drift',
          },
        ],
      },
    ]) {
      expect(() => normalizeRunManifest(invalid)).toThrow()
    }
  })

  test('atomically persists only fully validated result and manifest bytes', () => {
    const parent = tempRunParent()
    try {
      const runsRoot = path.join(parent, 'evals', 'runs')
      const persisted = persistEvalRun({
        runsRoot,
        manifest: validRunManifest(),
        results: [validResult()],
      })

      expect(persisted).toEqual({
        status: 'written',
        runId: 'run-002',
        manifestArtifactId: 'manifest.json',
        resultArtifactIds: ['results/bootstrap-loading/source.json'],
      })
      const runRoot = path.join(runsRoot, 'run-002')
      expect(fs.readFileSync(path.join(runRoot, 'manifest.json'), 'utf8')).toBe(
        serializeRunManifest(validRunManifest()),
      )
      expect(
        fs.readFileSync(
          path.join(runRoot, 'results/bootstrap-loading/source.json'),
          'utf8',
        ),
      ).toBe(serializeResult(validResult()))
      expect(fs.statSync(runRoot).mode & 0o777).toBe(0o700)
      expect(
        fs.statSync(path.join(runRoot, 'manifest.json')).mode & 0o777,
      ).toBe(0o600)
      expect(
        fs
          .readdirSync(runRoot, { recursive: true })
          .some((entry) => String(entry).includes('.tmp.')),
      ).toBe(false)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test('renames every result before the manifest commit marker', () => {
    const parent = tempRunParent()
    const renameOrder: string[] = []
    try {
      persistEvalRun({
        runsRoot: path.join(parent, 'evals', 'runs'),
        manifest: validRunManifest(),
        results: [validResult()],
        onRename: (relativeId) => renameOrder.push(relativeId),
      })

      expect(renameOrder).toEqual([
        'results/bootstrap-loading/source.json',
        'manifest.json',
      ])
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test('removes all finals and temps when the manifest commit rename fails', () => {
    const parent = tempRunParent()
    const runsRoot = path.join(parent, 'evals', 'runs')
    try {
      expect(() =>
        persistEvalRun({
          runsRoot,
          manifest: validRunManifest(),
          results: [validResult()],
          onRename: (relativeId) => {
            if (relativeId === 'manifest.json') {
              throw new Error('injected manifest rename failure')
            }
          },
        }),
      ).toThrow('eval-persist:atomic_write_failed')

      expect(fs.existsSync(path.join(runsRoot, 'run-002'))).toBe(false)
      expect(fs.existsSync(runsRoot)).toBe(true)
      expect(
        fs
          .readdirSync(runsRoot, { recursive: true })
          .some((entry) => String(entry).includes('.tmp.')),
      ).toBe(false)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test('rejects unsafe values before creating final or temporary artifacts', () => {
    const unsafeInputs = [
      {
        manifest: validRunManifest({ runId: 'ghp_fake_github_token_123' }),
        results: [validResult()],
      },
      {
        manifest: validRunManifest({
          results: [
            {
              selectionId: 'bootstrap-loading/source',
              resultArtifactId: '/tmp/private-result.json',
              outcome: 'success',
              subcode: 'none',
            },
          ],
        }),
        results: [validResult()],
      },
      {
        manifest: validRunManifest(),
        results: [
          {
            ...validResult(),
            evidence: {
              sanity: 'passed',
              process: 'completed',
              assertionIds: ['bootstrap-observed'],
              stdout: 'raw output must not persist',
            },
          },
        ],
      },
      {
        manifest: { ...validRunManifest(), unknownState: 'future' },
        results: [validResult()],
      },
    ]

    for (const [index, input] of unsafeInputs.entries()) {
      const parent = tempRunParent()
      try {
        const runsRoot = path.join(parent, `evals-${index}`, 'runs')
        expect(() => persistEvalRun({ runsRoot, ...input })).toThrow()
        expect(fs.existsSync(runsRoot)).toBe(false)
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    }
  })

  test('rejects traversal and keeps repeated persistence bytes deterministic', () => {
    const parent = tempRunParent()
    try {
      const firstRoot = path.join(parent, 'first', 'runs')
      const secondRoot = path.join(parent, 'second', 'runs')
      const firstManifest = validRunManifest({ runId: 'run-first' })
      const secondManifest = validRunManifest({ runId: 'run-second' })
      const firstResult = { ...validResult(), runId: 'run-first' }
      const secondResult = { ...validResult(), runId: 'run-second' }

      persistEvalRun({
        runsRoot: firstRoot,
        manifest: firstManifest,
        results: [firstResult],
      })
      persistEvalRun({
        runsRoot: secondRoot,
        manifest: secondManifest,
        results: [secondResult],
      })

      const normalizeRunId = (value: string): string =>
        value
          .replaceAll('run-first', 'run-opaque')
          .replaceAll('run-second', 'run-opaque')
      expect(
        normalizeRunId(
          fs.readFileSync(
            path.join(firstRoot, 'run-first', 'manifest.json'),
            'utf8',
          ),
        ),
      ).toBe(
        normalizeRunId(
          fs.readFileSync(
            path.join(secondRoot, 'run-second', 'manifest.json'),
            'utf8',
          ),
        ),
      )
      expect(
        normalizeRunId(
          fs.readFileSync(
            path.join(
              firstRoot,
              'run-first',
              'results/bootstrap-loading/source.json',
            ),
            'utf8',
          ),
        ),
      ).toBe(
        normalizeRunId(
          fs.readFileSync(
            path.join(
              secondRoot,
              'run-second',
              'results/bootstrap-loading/source.json',
            ),
            'utf8',
          ),
        ),
      )

      expect(() =>
        persistEvalRun({
          runsRoot: path.join(parent, 'traversal', 'runs'),
          manifest: validRunManifest({
            results: [
              {
                selectionId: 'bootstrap-loading/source',
                resultArtifactId: 'results/../../escape.json',
                outcome: 'success',
                subcode: 'none',
              },
            ],
          }),
          results: [validResult()],
        }),
      ).toThrow()
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test('accepts safe relative artifact IDs and rejects POSIX/Windows paths', () => {
    expect(
      normalizeResult({
        ...validResult(),
        artifactRefs: ['artifacts/result.json', 'fixture/output.txt'],
      }).artifactRefs,
    ).toEqual(['artifacts/result.json', 'fixture/output.txt'])

    for (const unsafePath of [
      '/tmp/private-result.json',
      'C:\\Users\\marcus\\private-result.json',
      'C:/Users/marcus/private-result.json',
      '\\\\server\\share\\private-result.json',
      '//server/share/private-result.json',
      '../private-result.json',
    ]) {
      expect(() =>
        normalizeResult({ ...validResult(), artifactRefs: [unsafePath] }),
      ).toThrow()
    }
  })

  test('rejects seeded fake credential, auth, key, token, and socket values without echoing them', () => {
    const seededValues = [
      'ghp_fake_github_token_123',
      'npm_fake_npm_token_123',
      'sk-fake-provider-key-123',
      'AKIAFAKECLOUDKEY123456',
      'fake-azure-client-secret',
      'fake-google-cloud-token',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      '/tmp/fake-ssh-agent.sock',
      'fake-git-password-123',
      'fake-opencode-auth-token',
    ]

    for (const seededValue of seededValues) {
      const message = rejectionMessage(() =>
        normalizeResult({
          ...validResult(),
          runId: seededValue,
        }),
      )
      expect(message).not.toContain(seededValue)
    }
  })

  test('rejects banned raw fields anywhere in nested candidates', () => {
    for (const field of [
      ...BANNED_FIELD_NAMES,
      'stdout',
      'stderr',
      'transcript',
      'env',
      'repositoryContent',
      'userProse',
      'configOverlay',
    ]) {
      const candidate = {
        ...validResult(),
        evidence: {
          sanity: 'passed',
          process: 'completed',
          assertionIds: ['bootstrap-observed'],
          nested: { [field]: 'sensitive value must not persist' },
        },
      }
      expect(() => serializeResult(candidate)).toThrow()
    }
  })

  test('uses the same banned field vocabulary for object and serialized validation', () => {
    for (const field of BANNED_FIELD_NAMES) {
      const candidate = {
        ...validResult(),
        evidence: {
          sanity: 'passed',
          process: 'completed',
          assertionIds: ['bootstrap-observed'],
          nested: { [field]: 'bounded sensitive value' },
        },
      }

      expect(() => normalizeResult(candidate)).toThrow()
      expect(() =>
        assertSerializedTextSafe(JSON.stringify({ [field]: 'bounded value' })),
      ).toThrow()
      expect(() =>
        validateSerializedResult(JSON.stringify(candidate)),
      ).toThrow()
    }
  })

  test('validates the entire serialized result on strings and bytes', () => {
    const serialized = serializeResult(validResult())
    expect(validateSerializedResult(serialized)).toEqual(
      normalizeResult(validResult()),
    )
    expect(
      validateSerializedResult(new TextEncoder().encode(serialized)),
    ).toEqual(normalizeResult(validResult()))

    const unsafeSerialized = serialized.replace(
      'artifacts/result.json',
      '/tmp/private-result.json',
    )
    expect(() => validateSerializedResult(unsafeSerialized)).toThrow()

    const rejectedValue = 'ghp_fake_serialized_token_456'
    const serializedWithSecret = serialized.replace('run-002', rejectedValue)
    const secretMessage = rejectionMessage(() =>
      validateSerializedResult(serializedWithSecret),
    )
    expect(secretMessage).not.toContain(rejectedValue)

    const malformedMessage = rejectionMessage(() =>
      validateSerializedResult('{"artifactRefs":["/tmp/private-result.json"]'),
    )
    expect(malformedMessage).not.toContain('/tmp/private-result.json')
  })

  test('does not write or execute a runner when imported', async () => {
    const scriptsDir = path.join(ROOT_DIR, 'scripts')
    const runsDir = path.join(ROOT_DIR, 'evals/runs')
    const before = fs.readdirSync(scriptsDir).sort()
    const runsBefore = fs.existsSync(runsDir)
      ? fs.readdirSync(runsDir, { recursive: true }).map(String).sort()
      : undefined
    await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-evals.ts')).href}?side-effect-check`
    )
    const after = fs.readdirSync(scriptsDir).sort()
    const runsAfter = fs.existsSync(runsDir)
      ? fs.readdirSync(runsDir, { recursive: true }).map(String).sort()
      : undefined

    expect(after).toEqual(before)
    expect(runsAfter).toEqual(runsBefore)
  })
})
