import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  computeCheckSummary,
  fetchUpstreamData,
  getExitCode,
  getRequiredUpstreamContentPaths,
  hasChanges,
  toDefinitionKey,
} from '../../scripts/check-cep-upstream.ts'
import type { SyncManifest } from '../../src/lib/manifest.ts'

const hash = (content: string): string =>
  createHash('sha256').update(content).digest('hex')

const baseManifest = (): SyncManifest => ({
  converter_version: 2,
  sources: {
    cep: {
      repo: 'EveryInc/compound-engineering-plugin',
      branch: 'main',
      url: 'https://github.com/EveryInc/compound-engineering-plugin',
    },
  },
  definitions: {
    'agents/review/security-sentinel': {
      source: 'cep',
      upstream_path:
        'plugins/compound-engineering/agents/review/security-sentinel.md',
      upstream_commit: 'abc123',
      synced_at: '2026-02-15T00:00:00Z',
      notes: 'test',
      upstream_content_hash: hash('agent'),
    },
  },
})

describe('check-cep-upstream helpers', () => {
  it('maps upstream paths to manifest definition keys', () => {
    expect(
      toDefinitionKey(
        'plugins/compound-engineering/agents/review/security-sentinel.md',
      ),
    ).toBe('agents/review/security-sentinel')
    expect(
      toDefinitionKey(
        'plugins/compound-engineering/commands/workflows/plan.md',
      ),
    ).toBe('commands/workflows/plan')
    expect(
      toDefinitionKey(
        'plugins/compound-engineering/skills/agent-native-architecture/SKILL.md',
      ),
    ).toBe('skills/agent-native-architecture')
    expect(
      toDefinitionKey(
        'plugins/compound-engineering/skills/agent-native-architecture/references/one.md',
      ),
    ).toBeNull()
  })

  it('collects upstream content paths for tracked definitions', () => {
    const manifest = baseManifest()
    manifest.definitions['skills/agent-native-architecture'] = {
      source: 'cep',
      upstream_path:
        'plugins/compound-engineering/skills/agent-native-architecture',
      upstream_commit: 'abc123',
      synced_at: '2026-02-15T00:00:00Z',
      notes: 'test',
      files: ['SKILL.md', 'references/one.md'],
      upstream_content_hash: hash('ab'),
    }

    const required = getRequiredUpstreamContentPaths({
      manifest,
      upstreamDefinitionKeys: [
        'agents/review/security-sentinel',
        'skills/agent-native-architecture',
      ],
    })

    expect(required).toEqual([
      'plugins/compound-engineering/agents/review/security-sentinel.md',
      'plugins/compound-engineering/skills/agent-native-architecture/SKILL.md',
      'plugins/compound-engineering/skills/agent-native-architecture/references/one.md',
    ])
  })
  it('returns no changes when hashes and converter version match', () => {
    const manifest = baseManifest()
    const upstreamContents = {
      'plugins/compound-engineering/agents/review/security-sentinel.md':
        'agent',
    }

    const summary = computeCheckSummary({
      manifest,
      upstreamDefinitionKeys: ['agents/review/security-sentinel'],
      upstreamContents,
      converterVersion: 2,
    })

    expect(hasChanges(summary)).toBe(false)
    expect(getExitCode(summary, false)).toBe(0)
  })

  it('reports hash changes when upstream content differs', () => {
    const manifest = baseManifest()
    const upstreamContents = {
      'plugins/compound-engineering/agents/review/security-sentinel.md':
        'changed',
    }

    const summary = computeCheckSummary({
      manifest,
      upstreamDefinitionKeys: ['agents/review/security-sentinel'],
      upstreamContents,
      converterVersion: 2,
    })

    expect(summary.hashChanges).toEqual(['agents/review/security-sentinel'])
    expect(hasChanges(summary)).toBe(true)
    expect(getExitCode(summary, false)).toBe(1)
  })

  it('reports converter version change', () => {
    const manifest = baseManifest()
    manifest.converter_version = 1
    const upstreamContents = {
      'plugins/compound-engineering/agents/review/security-sentinel.md':
        'agent',
    }

    const summary = computeCheckSummary({
      manifest,
      upstreamDefinitionKeys: ['agents/review/security-sentinel'],
      upstreamContents,
      converterVersion: 2,
    })

    expect(summary.converterVersionChanged).toBe(true)
    expect(hasChanges(summary)).toBe(true)
  })

  it('reports new upstream definitions and deletions', () => {
    const manifest = baseManifest()
    const upstreamContents = {
      'plugins/compound-engineering/agents/review/security-sentinel.md':
        'agent',
    }

    const summary = computeCheckSummary({
      manifest,
      upstreamDefinitionKeys: ['skills/new-skill'],
      upstreamContents,
      converterVersion: 2,
    })

    expect(summary.newUpstream).toEqual(['skills/new-skill'])
    expect(summary.deletions).toEqual(['agents/review/security-sentinel'])
    expect(hasChanges(summary)).toBe(true)
  })

  it('handles multi-file skills hashing', () => {
    const manifest: SyncManifest = {
      converter_version: 2,
      sources: {
        cep: {
          repo: 'EveryInc/compound-engineering-plugin',
          branch: 'main',
          url: 'https://github.com/EveryInc/compound-engineering-plugin',
        },
      },
      definitions: {
        'skills/agent-native-architecture': {
          source: 'cep',
          upstream_path:
            'plugins/compound-engineering/skills/agent-native-architecture',
          upstream_commit: 'abc123',
          synced_at: '2026-02-15T00:00:00Z',
          notes: 'test',
          files: ['SKILL.md', 'references/one.md'],
          upstream_content_hash: hash('a' + 'b'),
        },
      },
    }

    const upstreamContents = {
      'plugins/compound-engineering/skills/agent-native-architecture/SKILL.md':
        'a',
      'plugins/compound-engineering/skills/agent-native-architecture/references/one.md':
        'c',
    }

    const summary = computeCheckSummary({
      manifest,
      upstreamDefinitionKeys: ['skills/agent-native-architecture'],
      upstreamContents,
      converterVersion: 2,
    })

    expect(summary.hashChanges).toEqual(['skills/agent-native-architecture'])
  })

  it('skips definitions with wildcard manual_overrides', () => {
    const manifest = baseManifest()
    manifest.definitions['agents/review/security-sentinel'].manual_overrides = [
      {
        field: '*',
        reason: 'Local ownership',
        overridden_at: '2026-02-15T00:00:00Z',
      },
    ]

    const upstreamContents = {
      'plugins/compound-engineering/agents/review/security-sentinel.md':
        'changed',
    }

    const summary = computeCheckSummary({
      manifest,
      upstreamDefinitionKeys: ['agents/review/security-sentinel'],
      upstreamContents,
      converterVersion: 2,
    })

    expect(summary.skipped).toEqual(['agents/review/security-sentinel'])
    expect(summary.hashChanges).toEqual([])
  })

  it('returns error exit code when error flag is set', () => {
    const summary = {
      hashChanges: [],
      newUpstream: [],
      deletions: [],
      converterVersionChanged: false,
      skipped: [],
    }

    expect(getExitCode(summary, true)).toBe(2)
  })

  it('fetches upstream data using tree and content endpoints', async () => {
    const responses = new Map<string, Response>()
    const repo = 'EveryInc/compound-engineering-plugin'
    const branch = 'main'

    responses.set(
      `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
      new Response(
        JSON.stringify({
          tree: [
            {
              path: 'plugins/compound-engineering/agents/review/security-sentinel.md',
              type: 'blob',
            },
          ],
        }),
        { status: 200 },
      ),
    )

    responses.set(
      `https://api.github.com/repos/${repo}/contents/plugins/compound-engineering/agents/review/security-sentinel.md?ref=${branch}`,
      new Response(
        JSON.stringify({ content: Buffer.from('agent').toString('base64') }),
        { status: 200 },
      ),
    )

    const fetchFn = async (url: string): Promise<Response> => {
      const response = responses.get(url)
      if (!response) return new Response('missing', { status: 404 })
      return response
    }

    const result = await fetchUpstreamData(
      repo,
      branch,
      ['plugins/compound-engineering/agents/review/security-sentinel.md'],
      fetchFn,
    )

    expect(result.hadError).toBe(false)
    expect(result.definitionKeys).toEqual(['agents/review/security-sentinel'])
    expect(result.contents).toEqual({
      'plugins/compound-engineering/agents/review/security-sentinel.md':
        'agent',
    })
  })
})
