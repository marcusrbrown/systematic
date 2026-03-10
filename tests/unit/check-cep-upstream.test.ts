import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  collectNewUpstreamFiles,
  computeCheckSummary,
  createAuthenticatedFetch,
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
      treePaths: [],
      converterVersion: 2,
    })

    expect(hasChanges(summary)).toBe(false)
    expect(summary.errors).toEqual([])
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
      treePaths: [],
      converterVersion: 2,
    })

    expect(summary.hashChanges).toEqual(['agents/review/security-sentinel'])
    expect(summary.errors).toEqual([])
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
      treePaths: [],
      converterVersion: 2,
    })

    expect(summary.converterVersionChanged).toBe(true)
    expect(summary.errors).toEqual([])
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
      treePaths: [
        'plugins/compound-engineering/skills/new-skill/SKILL.md',
        'plugins/compound-engineering/skills/new-skill/references/guide.md',
      ],
      converterVersion: 2,
    })

    expect(summary.newUpstream).toEqual(['skills/new-skill'])
    expect(summary.newUpstreamFiles).toEqual({
      'skills/new-skill': ['SKILL.md', 'references/guide.md'],
    })
    expect(summary.deletions).toEqual(['agents/review/security-sentinel'])
    expect(summary.errors).toEqual([])
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
          upstream_content_hash: hash(`a\0b`),
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
      treePaths: [],
      converterVersion: 2,
    })

    expect(summary.hashChanges).toEqual(['skills/agent-native-architecture'])
    expect(summary.errors).toEqual([])
  })

  it('reports no change for multi-file skill with matching content', () => {
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
          upstream_content_hash: hash(`a\0b`),
        },
      },
    }

    const upstreamContents = {
      'plugins/compound-engineering/skills/agent-native-architecture/SKILL.md':
        'a',
      'plugins/compound-engineering/skills/agent-native-architecture/references/one.md':
        'b',
    }

    const summary = computeCheckSummary({
      manifest,
      upstreamDefinitionKeys: ['skills/agent-native-architecture'],
      upstreamContents,
      treePaths: [],
      converterVersion: 2,
    })

    expect(summary.hashChanges).toEqual([])
    expect(summary.errors).toEqual([])
    expect(hasChanges(summary)).toBe(false)
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
      treePaths: [],
      converterVersion: 2,
    })

    expect(summary.skipped).toEqual(['agents/review/security-sentinel'])
    expect(summary.errors).toEqual([])
    expect(summary.hashChanges).toEqual([])
  })

  it('returns error exit code when error flag is set', () => {
    const summary = {
      hashChanges: [],
      newUpstream: [],
      newUpstreamFiles: {},
      deletions: [],
      converterVersionChanged: false,
      skipped: [],
      errors: [],
    }

    expect(getExitCode(summary, true)).toBe(2)
  })

  it('flags missing multi-file contents as errors', () => {
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
    }

    const summary = computeCheckSummary({
      manifest,
      upstreamDefinitionKeys: ['skills/agent-native-architecture'],
      upstreamContents,
      treePaths: [],
      converterVersion: 2,
    })

    expect(summary.hashChanges).toEqual([])
    expect(summary.errors).toEqual([
      'Missing upstream content for sub-file (may be a transient fetch failure or the file was removed upstream): plugins/compound-engineering/skills/agent-native-architecture/references/one.md',
    ])
    expect(getExitCode(summary, false)).toBe(2)
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
    expect(result.treePaths).toEqual([
      'plugins/compound-engineering/agents/review/security-sentinel.md',
    ])
    expect(result.contents).toEqual({
      'plugins/compound-engineering/agents/review/security-sentinel.md':
        'agent',
    })
  })

  it('retries content fetch on 429 and succeeds', async () => {
    const repo = 'EveryInc/compound-engineering-plugin'
    const branch = 'main'
    const contentPath =
      'plugins/compound-engineering/agents/review/security-sentinel.md'
    const responses = new Map<string, Response>()

    responses.set(
      `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
      new Response(
        JSON.stringify({
          tree: [
            {
              path: contentPath,
              type: 'blob',
            },
          ],
        }),
        { status: 200 },
      ),
    )

    let contentCalls = 0
    const fetchFn = async (url: string): Promise<Response> => {
      if (
        url ===
        `https://api.github.com/repos/${repo}/contents/${contentPath}?ref=${branch}`
      ) {
        contentCalls += 1
        if (contentCalls < 2) {
          return new Response('rate limited', { status: 429 })
        }
        return new Response(
          JSON.stringify({ content: Buffer.from('agent').toString('base64') }),
          { status: 200 },
        )
      }
      return responses.get(url) ?? new Response('missing', { status: 404 })
    }

    const result = await fetchUpstreamData(repo, branch, [contentPath], fetchFn)

    expect(contentCalls).toBe(2)
    expect(result.hadError).toBe(false)
    expect(result.contents[contentPath]).toBe('agent')
  })

  it('retries tree fetch on 403 and succeeds', async () => {
    const repo = 'EveryInc/compound-engineering-plugin'
    const branch = 'main'
    const contentPath =
      'plugins/compound-engineering/agents/review/security-sentinel.md'

    let treeCalls = 0
    const fetchFn = async (url: string): Promise<Response> => {
      if (
        url ===
        `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`
      ) {
        treeCalls += 1
        if (treeCalls < 2) {
          return new Response('forbidden', { status: 403 })
        }
        return new Response(
          JSON.stringify({
            tree: [
              {
                path: contentPath,
                type: 'blob',
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (
        url ===
        `https://api.github.com/repos/${repo}/contents/${contentPath}?ref=${branch}`
      ) {
        return new Response(
          JSON.stringify({ content: Buffer.from('agent').toString('base64') }),
          { status: 200 },
        )
      }
      return new Response('missing', { status: 404 })
    }

    const result = await fetchUpstreamData(repo, branch, [contentPath], fetchFn)

    expect(treeCalls).toBe(2)
    expect(result.hadError).toBe(false)
    expect(result.definitionKeys).toEqual(['agents/review/security-sentinel'])
  })

  it('returns hadError when retries are exhausted', async () => {
    const repo = 'EveryInc/compound-engineering-plugin'
    const branch = 'main'
    const contentPath =
      'plugins/compound-engineering/agents/review/security-sentinel.md'

    const fetchFn = async (url: string): Promise<Response> => {
      if (
        url ===
        `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`
      ) {
        return new Response('rate limited', { status: 429 })
      }
      return new Response('missing', { status: 404 })
    }

    const result = await fetchUpstreamData(repo, branch, [contentPath], fetchFn)

    expect(result.hadError).toBe(true)
  })

  it('does not set hadError for 404 content responses', async () => {
    const repo = 'EveryInc/compound-engineering-plugin'
    const branch = 'main'
    const contentPath =
      'plugins/compound-engineering/agents/review/security-sentinel.md'

    const fetchFn = async (url: string): Promise<Response> => {
      if (
        url ===
        `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`
      ) {
        return new Response(
          JSON.stringify({
            tree: [
              {
                path: contentPath,
                type: 'blob',
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('not found', { status: 404 })
    }

    const result = await fetchUpstreamData(repo, branch, [contentPath], fetchFn)

    expect(result.hadError).toBe(false)
    expect(result.contents).toEqual({})
    expect(result.definitionKeys).toEqual(['agents/review/security-sentinel'])
  })

  it('sets hadError for 500 content responses', async () => {
    const repo = 'EveryInc/compound-engineering-plugin'
    const branch = 'main'
    const contentPath =
      'plugins/compound-engineering/agents/review/security-sentinel.md'

    const fetchFn = async (url: string): Promise<Response> => {
      if (
        url ===
        `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`
      ) {
        return new Response(
          JSON.stringify({
            tree: [
              {
                path: contentPath,
                type: 'blob',
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('server error', { status: 500 })
    }

    const result = await fetchUpstreamData(repo, branch, [contentPath], fetchFn)

    expect(result.hadError).toBe(true)
    expect(result.contents).toEqual({})
  })

  it('returns treePaths from fetchUpstreamData', async () => {
    const repo = 'EveryInc/compound-engineering-plugin'
    const branch = 'main'

    const fetchFn = async (url: string): Promise<Response> => {
      if (url.includes('/git/trees/')) {
        return new Response(
          JSON.stringify({
            tree: [
              {
                path: 'plugins/compound-engineering/skills/my-skill/SKILL.md',
                type: 'blob',
              },
              {
                path: 'plugins/compound-engineering/skills/my-skill/references/guide.md',
                type: 'blob',
              },
              {
                path: 'plugins/compound-engineering/skills/my-skill/scripts',
                type: 'tree',
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('not found', { status: 404 })
    }

    const result = await fetchUpstreamData(repo, branch, [], fetchFn)

    expect(result.treePaths).toEqual([
      'plugins/compound-engineering/skills/my-skill/SKILL.md',
      'plugins/compound-engineering/skills/my-skill/references/guide.md',
    ])
  })

  it('collects files for new skill definitions from tree paths', () => {
    const treePaths = [
      'plugins/compound-engineering/skills/new-skill/SKILL.md',
      'plugins/compound-engineering/skills/new-skill/references/guide.md',
      'plugins/compound-engineering/skills/new-skill/scripts/setup.sh',
      'plugins/compound-engineering/skills/existing-skill/SKILL.md',
      'plugins/compound-engineering/agents/review/some-agent.md',
    ]

    const result = collectNewUpstreamFiles(treePaths, ['skills/new-skill'])

    expect(result).toEqual({
      'skills/new-skill': [
        'SKILL.md',
        'references/guide.md',
        'scripts/setup.sh',
      ],
    })
  })

  it('collects single file for new agent definitions', () => {
    const treePaths = [
      'plugins/compound-engineering/agents/review/new-agent.md',
      'plugins/compound-engineering/agents/review/other-agent.md',
    ]

    const result = collectNewUpstreamFiles(treePaths, [
      'agents/review/new-agent',
    ])

    expect(result).toEqual({
      'agents/review/new-agent': ['new-agent.md'],
    })
  })

  it('returns empty files for keys not found in tree', () => {
    const treePaths = ['plugins/compound-engineering/agents/review/existing.md']

    const result = collectNewUpstreamFiles(treePaths, ['skills/ghost-skill'])

    expect(result).toEqual({})
  })

  it('collects files for multiple new definitions at once', () => {
    const treePaths = [
      'plugins/compound-engineering/skills/skill-a/SKILL.md',
      'plugins/compound-engineering/skills/skill-a/references/ref.md',
      'plugins/compound-engineering/skills/skill-b/SKILL.md',
      'plugins/compound-engineering/commands/workflows/new-cmd.md',
    ]

    const result = collectNewUpstreamFiles(treePaths, [
      'skills/skill-a',
      'skills/skill-b',
      'commands/workflows/new-cmd',
    ])

    expect(result).toEqual({
      'skills/skill-a': ['SKILL.md', 'references/ref.md'],
      'skills/skill-b': ['SKILL.md'],
      'commands/workflows/new-cmd': ['new-cmd.md'],
    })
  })

  it('returns raw fetch when no token is provided', () => {
    const fetchFn = createAuthenticatedFetch(undefined)
    expect(fetchFn).toBe(fetch)
  })

  it('returns raw fetch when token is empty string', () => {
    const fetchFn = createAuthenticatedFetch('')
    expect(fetchFn).toBe(fetch)
  })

  it('returns authenticated fetch wrapper when token is provided', async () => {
    const fetchFn = createAuthenticatedFetch('ghp_test123')
    expect(fetchFn).not.toBe(fetch)

    let capturedHeaders: Headers | undefined
    const originalFetch = globalThis.fetch
    const mockFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response('ok', { status: 200 })
    }
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch

    try {
      await fetchFn('https://api.github.com/test')
      expect(capturedHeaders?.get('Authorization')).toBe('Bearer ghp_test123')
      expect(capturedHeaders?.get('Accept')).toBe(
        'application/vnd.github.v3+json',
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('includes newUpstreamFiles in computeCheckSummary for new skills', () => {
    const manifest = baseManifest()
    const treePaths = [
      'plugins/compound-engineering/skills/new-multi-skill/SKILL.md',
      'plugins/compound-engineering/skills/new-multi-skill/references/api.md',
      'plugins/compound-engineering/skills/new-multi-skill/scripts/init.sh',
      'plugins/compound-engineering/agents/review/security-sentinel.md',
    ]

    const summary = computeCheckSummary({
      manifest,
      upstreamDefinitionKeys: [
        'agents/review/security-sentinel',
        'skills/new-multi-skill',
      ],
      upstreamContents: {
        'plugins/compound-engineering/agents/review/security-sentinel.md':
          'agent',
      },
      treePaths,
      converterVersion: 2,
    })

    expect(summary.newUpstream).toEqual(['skills/new-multi-skill'])
    expect(summary.newUpstreamFiles).toEqual({
      'skills/new-multi-skill': [
        'SKILL.md',
        'references/api.md',
        'scripts/init.sh',
      ],
    })
  })
})
