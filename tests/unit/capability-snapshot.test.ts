import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  buildCapabilitySnapshot,
  type ConfigObservationMetadata,
} from '../../src/lib/capability-snapshot.js'

const OBSERVED_AT = '2026-08-13T12:34:56.000Z'
const ABSOLUTE_ROOT = '/Users/marcus/private/project'
const SECRET = 'customer-token-and-private-stack'
const USER_CONFIG_PATH = `${ABSOLUTE_ROOT}/user/systematic.json`
const PROJECT_CONFIG_PATH = `${ABSOLUTE_ROOT}/project/systematic.json`
const CUSTOM_CONFIG_PATH = `${ABSOLUTE_ROOT}/custom/systematic.json`

type CapabilitySnapshotBuilderOptions = Parameters<
  typeof buildCapabilitySnapshot
>[0]
type CapabilitySnapshot = ReturnType<typeof buildCapabilitySnapshot>

function baseOptions(
  overrides: Partial<CapabilitySnapshotBuilderOptions> = {},
): CapabilitySnapshotBuilderOptions {
  return {
    argv: ['systematic', 'capabilities'],
    package: {
      name: '@fro.bot/systematic',
      version: '1.2.3',
    },
    roots: [],
    clock: () => Date.parse(OBSERVED_AT),
    ...overrides,
  }
}

function expectSortedKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectSortedKeys(item)
    return
  }

  if (value === null || typeof value !== 'object') return

  const record = value as Record<string, unknown>
  expect(Object.keys(record)).toEqual([...Object.keys(record)].sort())
  for (const nested of Object.values(record)) expectSortedKeys(nested)
}

describe('capability snapshot contract', () => {
  test('builds the minimal versioned identity shape', () => {
    const snapshot = buildCapabilitySnapshot(baseOptions())

    expect(snapshot).toEqual({
      command: 'systematic capabilities',
      facts: [],
      identity: {
        argv: {
          executable: 'systematic',
          subcommand: 'capabilities',
        },
        package: {
          name: '@fro.bot/systematic',
          version: '1.2.3',
        },
      },
      observedAt: OBSERVED_AT,
      roots: [],
      schemaVersion: 'cli-capabilities.v1',
      sources: [],
    })
  })

  test('serializes identically for identical inputs and a frozen clock', () => {
    const options = baseOptions({
      roots: [{ id: 'cwd', path: ABSOLUTE_ROOT }],
      sources: [
        {
          sourceId: 'config:project',
          presence: 'present',
          path: `${ABSOLUTE_ROOT}/.config/systematic.json`,
        },
      ],
      facts: [
        {
          factId: 'host-runtime',
          status: 'unknown',
          limitationCode: 'host-runtime-unobservable',
        },
      ],
    })

    const first = JSON.stringify(buildCapabilitySnapshot(options))
    const second = JSON.stringify(buildCapabilitySnapshot(options))

    expect(first).toBe(second)
  })

  test('sorts roots, facts, sources, collections, and object keys deterministically', () => {
    const snapshot = buildCapabilitySnapshot(
      baseOptions({
        roots: [
          { id: 'project', path: `${ABSOLUTE_ROOT}/project` },
          { id: 'cwd', path: ABSOLUTE_ROOT },
        ],
        sources: [
          { sourceId: 'config:user', presence: 'absent' },
          {
            sourceId: 'config:project',
            presence: 'present',
            path: `${ABSOLUTE_ROOT}/project/systematic.json`,
          },
        ],
        facts: [
          {
            factId: 'host-runtime',
            status: 'unknown',
            limitationCode: 'host-runtime-unobservable',
          },
          { factId: 'config-authority', status: 'available' },
        ],
      }),
    )

    const parsed = JSON.parse(JSON.stringify(snapshot)) as unknown
    expectSortedKeys(parsed)
    expect(snapshot.roots.map((root) => root.id)).toEqual(['cwd', 'project'])
    expect(snapshot.sources.map((source) => source.sourceId)).toEqual([
      'config:project',
      'config:user',
    ])
    expect(snapshot.facts.map((fact) => fact.factId)).toEqual([
      'config-authority',
      'host-runtime',
    ])
  })

  test('keeps absent, unknown, and unavailable semantics distinct', () => {
    const snapshot = buildCapabilitySnapshot(
      baseOptions({
        sources: [
          { sourceId: 'config:project', presence: 'absent' },
          {
            sourceId: 'config:user',
            presence: 'invalid',
            errorCode: 'source-malformed',
          },
        ],
        facts: [
          {
            factId: 'host-runtime',
            status: 'unknown',
            limitationCode: 'host-runtime-unobservable',
          },
          {
            factId: 'config-authority',
            status: 'unavailable',
            sourceId: 'config:user',
            errorCode: 'source-read-failed',
          },
        ],
      }),
    )

    expect(snapshot.sources).toEqual([
      {
        kind: 'source',
        presence: 'absent',
        sourceId: 'config:project',
      },
      {
        errorCode: 'source-malformed',
        kind: 'source',
        presence: 'invalid',
        sourceId: 'config:user',
      },
    ])
    expect(snapshot.facts).toEqual([
      {
        factId: 'config-authority',
        kind: 'status',
        errorCode: 'source-read-failed',
        sourceId: 'config:user',
        status: 'unavailable',
      },
      {
        factId: 'host-runtime',
        kind: 'status',
        limitationCode: 'host-runtime-unobservable',
        status: 'unknown',
      },
    ])
  })

  test('rejects incomplete available discovery summaries', () => {
    expect(() =>
      buildCapabilitySnapshot(
        baseOptions({
          facts: [{ factId: 'discovery-summary', status: 'available' }],
        }),
      ),
    ).toThrow(/discovery/i)
  })

  test('rejects impossible discovery source issue states', () => {
    const invalidFacts: readonly unknown[] = [
      {
        factId: 'discovery-source-issue',
        status: 'available',
      },
      {
        factId: 'discovery-source-issue',
        limitationCode: 'authority-unproven',
        status: 'unknown',
      },
      {
        errorCode: 'source-malformed',
        factId: 'discovery-source-issue',
        status: 'unavailable',
      },
      {
        errorCode: 'source-malformed',
        factId: 'discovery-source-issue',
        sourceId: 'discovery:agents',
        status: 'unavailable',
      },
    ]

    for (const fact of invalidFacts) {
      expect(() =>
        buildCapabilitySnapshot(baseOptions({ facts: [fact as never] })),
      ).toThrow(/discovery-source-issue|sourceId|status/i)
    }
  })

  test('projects bounded config source presence and proven field authority', () => {
    const config: ConfigObservationMetadata = {
      authorities: [
        { fieldPath: 'bootstrap.enabled', sourceKind: 'project' },
        { fieldPath: 'workflow_guard.mode', sourceKind: 'user' },
        { fieldPath: 'skills_as_commands', sourceKind: 'custom' },
      ],
      protectedFields: [
        {
          fieldPath: 'workflow_guard',
          outcome: 'blocked',
          sourceKind: 'project',
        },
      ],
      sources: [
        {
          kind: 'custom',
          path: CUSTOM_CONFIG_PATH,
          presence: 'present',
        },
        {
          kind: 'project',
          path: PROJECT_CONFIG_PATH,
          presence: 'absent',
        },
        {
          kind: 'user',
          path: USER_CONFIG_PATH,
          presence: 'present',
        },
      ],
    }

    const snapshot = buildCapabilitySnapshot(baseOptions({ config }))

    expect(snapshot.sources).toEqual([
      {
        kind: 'source',
        presence: 'present',
        sourceId: 'config:custom',
        sourceKind: 'custom',
      },
      {
        kind: 'source',
        presence: 'absent',
        sourceId: 'config:project',
        sourceKind: 'project',
      },
      {
        kind: 'source',
        presence: 'present',
        sourceId: 'config:user',
        sourceKind: 'user',
      },
    ])
    expect(snapshot.facts).toContainEqual({
      factId: 'config-field-authority',
      fieldPath: 'bootstrap.enabled',
      kind: 'authority',
      sourceId: 'config:project',
      status: 'available',
    })
    expect(snapshot.facts).toContainEqual({
      factId: 'config-field-authority',
      fieldPath: 'workflow_guard.mode',
      kind: 'authority',
      sourceId: 'config:user',
      status: 'available',
    })
    expect(snapshot.facts).toContainEqual({
      factId: 'config-field-authority',
      fieldPath: 'skills_as_commands',
      kind: 'authority',
      sourceId: 'config:custom',
      status: 'available',
    })
    expect(snapshot.facts).toContainEqual({
      factId: 'config-protected-field',
      fieldPath: 'workflow_guard',
      kind: 'protection',
      outcome: 'blocked',
      sourceId: 'config:project',
      status: 'available',
    })
  })

  test('maps invalid config sources to sanitized unavailable metadata', () => {
    const snapshot = buildCapabilitySnapshot(
      baseOptions({
        config: {
          authorities: [],
          protectedFields: [],
          sources: [
            {
              errorCode: 'parse-failed',
              kind: 'project',
              path: `${ABSOLUTE_ROOT}/project/systematic.json`,
              presence: 'invalid',
            },
          ],
        },
      }),
    )

    expect(snapshot.sources).toEqual([
      {
        errorCode: 'source-malformed',
        kind: 'source',
        presence: 'invalid',
        sourceId: 'config:project',
        sourceKind: 'project',
      },
    ])
    expect(JSON.stringify(snapshot)).not.toContain(ABSOLUTE_ROOT)
    expect(JSON.stringify(snapshot)).not.toContain(SECRET)
  })

  test('deduplicates canonical and symlink-equivalent config source paths', () => {
    const snapshot = buildCapabilitySnapshot(
      baseOptions({
        config: {
          authorities: [],
          protectedFields: [],
          sources: [
            {
              kind: 'custom',
              path: `${ABSOLUTE_ROOT}/config/../config/systematic.json`,
              presence: 'present',
            },
            {
              kind: 'user',
              path: `${ABSOLUTE_ROOT}/config/systematic.json`,
              presence: 'present',
            },
          ],
        },
      }),
    )

    expect(snapshot.sources).toHaveLength(1)
    expect(snapshot.sources[0]).toEqual({
      kind: 'source',
      presence: 'present',
      sourceId: 'config:custom',
      sourceKind: 'custom',
    })
  })

  test('rejects privacy-sensitive arbitrary values and unknown keys', () => {
    for (const [key, value] of [
      ['overlay', { nested: { token: SECRET } }],
      ['rawError', { message: SECRET, stack: SECRET }],
      ['unknownOutputKey', SECRET],
    ] as const) {
      const unsafeInput = {
        ...baseOptions(),
        [key]: value,
      } as unknown as CapabilitySnapshotBuilderOptions

      expect(() => buildCapabilitySnapshot(unsafeInput)).toThrow(
        `options has unknown key ${key}`,
      )
    }

    const unsafeConfig = {
      authorities: [],
      protectedFields: [],
      rawError: { message: SECRET, stack: SECRET },
      sources: [],
    } as unknown as ConfigObservationMetadata
    expect(() =>
      buildCapabilitySnapshot(baseOptions({ config: unsafeConfig })),
    ).toThrow('config has unknown key rawError')

    const serialized = JSON.stringify(
      buildCapabilitySnapshot(
        baseOptions({
          roots: [{ id: 'cwd', path: ABSOLUTE_ROOT }],
          sources: [
            {
              sourceId: 'config:project',
              presence: 'present',
              path: `${ABSOLUTE_ROOT}/systematic.json`,
            },
          ],
        }),
      ),
    )
    expect(serialized).not.toContain(ABSOLUTE_ROOT)
    expect(serialized).not.toContain(SECRET)
  })

  test('keeps a JSON round trip stable', () => {
    const snapshot = buildCapabilitySnapshot(
      baseOptions({
        roots: [{ id: 'cwd', path: ABSOLUTE_ROOT }],
        sources: [
          {
            sourceId: 'config:project',
            presence: 'present',
            path: `${ABSOLUTE_ROOT}/systematic.json`,
          },
        ],
        facts: [
          {
            count: 0,
            discoveryId: 'skills',
            factId: 'discovery-summary',
            kind: 'discovery',
            sourceId: 'discovery:skills',
            status: 'available',
            winningRoots: [],
          },
        ],
      }),
    )
    const serialized = JSON.stringify(snapshot)
    const roundTripped = JSON.parse(serialized) as CapabilitySnapshot

    expect(roundTripped).toEqual(snapshot)
    expect(JSON.stringify(roundTripped)).toBe(serialized)
  })

  test('serializes an allowlisted discovery summary with bounded winners', () => {
    const snapshot = buildCapabilitySnapshot(
      baseOptions({
        facts: [
          {
            count: 2,
            discoveryId: 'skills',
            factId: 'discovery-summary',
            kind: 'discovery',
            sourceId: 'discovery:skills',
            status: 'available',
            winningRoots: ['global-opencode-config', 'project-opencode'],
          },
        ],
      }),
    )

    expect(snapshot.facts).toEqual([
      {
        count: 2,
        discoveryId: 'skills',
        factId: 'discovery-summary',
        kind: 'discovery',
        sourceId: 'discovery:skills',
        status: 'available',
        winningRoots: ['global-opencode-config', 'project-opencode'],
      },
    ])
  })

  test('accepts an output sink without performing filesystem writes', () => {
    let emitted = ''
    const snapshot = buildCapabilitySnapshot(
      baseOptions({ outputSink: (value) => (emitted = value) }),
    )

    expect(emitted).toBe(JSON.stringify(snapshot))
  })

  test('does not import runtime collectors or write to the filesystem', () => {
    const source = readFileSync(
      new URL('../../src/lib/capability-snapshot.ts', import.meta.url),
      'utf8',
    )

    expect(source).not.toMatch(
      /from ['"][^'"]*(bootstrap|config-handler|runtime)/,
    )
    expect(source).not.toMatch(
      /from ['"]node:fs['"]|writeFile|mkdir|rmSync|unlink/,
    )
  })
})
