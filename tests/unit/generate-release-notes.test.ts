import { describe, expect, spyOn, test } from 'bun:test'
import { createRequire } from 'node:module'
import path from 'node:path'
import yaml from 'js-yaml'
import {
  type GithubRelease,
  generateReleaseNotesPage,
  renderReleaseNotesPage,
} from '../../docs/scripts/generate-release-notes.ts'

const NARRATIVE_BODY = [
  "## What's new",
  '',
  'Fro Bot shipped a **big** change.',
  '',
  '### Highlights',
  '',
  '- Faster builds',
  '- Safer releases',
  '',
  'See [the PR](https://github.com/marcusrbrown/systematic/pull/1).',
].join('\n')

function makeRelease(overrides: Partial<GithubRelease> = {}): GithubRelease {
  return {
    tag_name: 'v1.0.0',
    name: 'v1.0.0',
    body: NARRATIVE_BODY,
    draft: false,
    prerelease: false,
    published_at: '2026-01-10T12:00:00Z',
    created_at: '2026-01-10T11:00:00Z',
    updated_at: '2026-01-11T09:30:00Z',
    html_url: 'https://github.com/marcusrbrown/systematic/releases/tag/v1.0.0',
    ...overrides,
  }
}

function jsonResponse(data: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function headingLevels(markdown: string): number[] {
  const levels: number[] = []
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1]
      if (fence === null) fence = marker
      else if (
        marker.startsWith(fence[0] ?? '') &&
        marker.length >= fence.length
      )
        fence = null
      continue
    }
    if (fence !== null) continue
    const heading = line.match(/^(#{1,6})\s/)
    if (heading?.[1]) levels.push(heading[1].length)
  }
  return levels
}

interface MarkdownlintModule {
  lint: (options: {
    strings: Record<string, string>
    config: Record<string, unknown>
  }) => Promise<Record<string, unknown[]>>
}

async function lintMarkdown(markdown: string): Promise<unknown[]> {
  // markdownlint is a transitive dependency of markdownlint-cli (a devDependency).
  // Under bun's isolated linker it is not resolvable from the repo root, so
  // resolve it relative to the CLI package that depends on it.
  const require = createRequire(import.meta.url)
  const cliDir = path.dirname(require.resolve('markdownlint-cli/package.json'))
  const modulePath = Bun.resolveSync('markdownlint/promise', cliDir)
  const markdownlint = (await import(modulePath)) as MarkdownlintModule
  const configPath = path.resolve(import.meta.dir, '../../.markdownlint.yaml')
  const config = yaml.load(await Bun.file(configPath).text()) as Record<
    string,
    unknown
  >
  const results = await markdownlint.lint({
    strings: { page: markdown },
    config,
  })
  return results.page ?? []
}

describe('renderReleaseNotesPage', () => {
  test('renders releases newest first with version headings', () => {
    const page = renderReleaseNotesPage([
      makeRelease({
        tag_name: 'v1.0.0',
        name: 'v1.0.0',
        published_at: '2026-01-10T12:00:00Z',
      }),
      makeRelease({
        tag_name: 'v1.2.0',
        name: 'v1.2.0',
        published_at: '2026-03-10T12:00:00Z',
      }),
      makeRelease({
        tag_name: 'v1.1.0',
        name: 'v1.1.0',
        published_at: '2026-02-10T12:00:00Z',
      }),
    ])

    const v120 = page.indexOf('## v1.2.0')
    const v110 = page.indexOf('## v1.1.0')
    const v100 = page.indexOf('## v1.0.0')
    expect(v120).toBeGreaterThan(-1)
    expect(v110).toBeGreaterThan(v120)
    expect(v100).toBeGreaterThan(v110)
    expect(page).toContain('2026-03-10')
    expect(page).toContain('2026-01-11')
  })

  test('renders a narrated body under its version with headings demoted', () => {
    const page = renderReleaseNotesPage([makeRelease()])

    expect(page).toContain("### What's new")
    expect(page).toContain('#### Highlights')
    expect(page).toContain('Fro Bot shipped a **big** change.')
    expect(page).not.toContain('Narrative unavailable')
    // Narrative heading must follow the version heading, not precede it.
    expect(page.indexOf('## v1.0.0')).toBeLessThan(
      page.indexOf("### What's new"),
    )
    // Frontmatter title is the h1; the body must never add another.
    expect(headingLevels(page)).not.toContain(1)
  })

  test('labels a body without the narrative marker as unavailable', () => {
    const page = renderReleaseNotesPage([
      makeRelease({
        tag_name: 'v0.9.0',
        name: 'v0.9.0',
        body: '## Changelog\n\n- fix: a thing',
      }),
    ])

    const labelAt = page.indexOf('Narrative unavailable')
    expect(labelAt).toBeGreaterThan(-1)
    expect(labelAt).toBeGreaterThan(page.indexOf('## v0.9.0'))
    expect(labelAt).toBeLessThan(page.indexOf('fix: a thing'))
    expect(page).toContain('fix: a thing')
  })

  test('labels an empty or null body as unavailable', () => {
    const page = renderReleaseNotesPage([makeRelease({ body: null })])
    expect(page).toContain('Narrative unavailable')
  })

  test('excludes drafts and prereleases', () => {
    const page = renderReleaseNotesPage([
      makeRelease({ tag_name: 'v2.0.0', name: 'v2.0.0' }),
      makeRelease({
        tag_name: 'v3.0.0-draft',
        name: 'v3.0.0-draft',
        draft: true,
      }),
      makeRelease({
        tag_name: 'v3.0.0-rc.1',
        name: 'v3.0.0-rc.1',
        prerelease: true,
      }),
    ])

    expect(page).toContain('## v2.0.0')
    expect(page).not.toContain('v3.0.0-draft')
    expect(page).not.toContain('v3.0.0-rc.1')
  })

  test('emits frontmatter with title and description', () => {
    const page = renderReleaseNotesPage([makeRelease()])
    const match = page.match(/^---\n([\s\S]*?)\n---\n/)
    expect(match).not.toBeNull()
    const data = yaml.load(match?.[1] ?? '') as Record<string, unknown>
    expect(data.title).toBe('Release notes')
    expect(typeof data.description).toBe('string')
  })

  test('neutralizes hostile body content', () => {
    const hostile = [
      "## What's new",
      '',
      '<script>alert(1)</script>',
      '',
      'Leak {process.env.SECRET} and {{ injected }}.',
      '',
      '[click me](javascript:alert(1)) and [ok](https://example.com/ok)',
      '',
      '[data](data:text/html;base64,AAAA) and [rel](/relative)',
      '',
      '<img src=x onerror=alert(1)>',
      '',
      '[ref]: javascript:alert(2)',
      '',
      '```js',
      'unterminated fence that must not swallow the next release',
    ].join('\n')

    const page = renderReleaseNotesPage([
      makeRelease({ tag_name: 'v2.0.0', name: 'v2.0.0', body: hostile }),
      makeRelease({
        tag_name: 'v1.0.0',
        name: 'v1.0.0',
        published_at: '2026-01-01T00:00:00Z',
      }),
    ])

    expect(page).not.toMatch(/<script/i)
    expect(page).not.toContain('</script>')
    expect(page).not.toMatch(/<img/i)
    expect(page).not.toContain('{process.env.SECRET}')
    expect(page).not.toContain('{{ injected }}')
    expect(page).not.toMatch(/javascript:/i)
    expect(page).not.toMatch(/\(data:/i)
    expect(page).not.toContain('(/relative)')
    // Link text survives; https links survive.
    expect(page).toContain('click me')
    expect(page).toContain('[ok](https://example.com/ok)')
    // The unterminated fence is closed, so the next release is real markdown.
    expect(headingLevels(page).filter((l) => l === 2)).toHaveLength(2)
    expect(page.indexOf('## v1.0.0')).toBeGreaterThan(
      page.indexOf('unterminated fence'),
    )
    const fenceLines = page.split('\n').filter((l) => /^```/.test(l))
    expect(fenceLines.length % 2).toBe(0)
  })

  test('truncates oversized bodies with a note', () => {
    const body = `## What's new\n\n${'word '.repeat(10000)}`
    const page = renderReleaseNotesPage([makeRelease({ body })])

    expect(page.length).toBeLessThan(25000)
    expect(page.toLowerCase()).toContain('truncated')
    expect(page).toContain('releases/tag/v1.0.0')
  })

  test('output passes markdownlint with the repo config', async () => {
    const page = renderReleaseNotesPage([
      makeRelease({
        tag_name: 'v1.1.0',
        name: 'v1.1.0',
        published_at: '2026-02-01T00:00:00Z',
      }),
      makeRelease({
        tag_name: 'v1.0.0',
        name: 'v1.0.0',
        published_at: '2026-01-01T00:00:00Z',
        body: '# Old style title\n\n## Changelog\n\n#### Deep\n\n* item one\n* item two\n\n```ts\nconst x = { a: 1 }\n```',
      }),
    ])

    const problems = await lintMarkdown(page)
    expect(problems).toEqual([])

    const levels = headingLevels(page)
    expect(levels).not.toContain(1)
    for (let i = 1; i < levels.length; i++) {
      expect((levels[i] ?? 0) - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1)
    }
  })
})

describe('generateReleaseNotesPage', () => {
  test('without a token writes a stub and never fetches', async () => {
    let calls = 0
    const page = await generateReleaseNotesPage({
      token: undefined,
      fetchImpl: async () => {
        calls++
        return jsonResponse([])
      },
    })

    expect(calls).toBe(0)
    expect(page).toContain('Release notes')
    expect(page).toContain(
      'https://github.com/marcusrbrown/systematic/releases',
    )
    expect(page).not.toContain('Narrative unavailable')
  })

  test('treats an empty token as no token', async () => {
    let calls = 0
    await generateReleaseNotesPage({
      token: '',
      fetchImpl: async () => {
        calls++
        return jsonResponse([])
      },
    })
    expect(calls).toBe(0)
  })

  test('fetches and merges every page, sending the token', async () => {
    const requests: Array<{ url: string; auth: string | null }> = []
    const page2Url =
      'https://api.github.com/repositories/1/releases?per_page=100&page=2'
    const page = await generateReleaseNotesPage({
      token: 'secret-token',
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers)
        requests.push({ url: String(url), auth: headers.get('authorization') })
        if (String(url).includes('page=2')) {
          return jsonResponse([
            makeRelease({
              tag_name: 'v1.0.0',
              name: 'v1.0.0',
              published_at: '2026-01-01T00:00:00Z',
            }),
          ])
        }
        return jsonResponse(
          [
            makeRelease({
              tag_name: 'v1.1.0',
              name: 'v1.1.0',
              published_at: '2026-02-01T00:00:00Z',
            }),
          ],
          { link: `<${page2Url}>; rel="next"` },
        )
      },
    })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toContain(
      '/repos/marcusrbrown/systematic/releases?per_page=100',
    )
    expect(requests.every((r) => r.auth === 'Bearer secret-token')).toBe(true)
    expect(page.indexOf('## v1.1.0')).toBeGreaterThan(-1)
    expect(page.indexOf('## v1.0.0')).toBeGreaterThan(page.indexOf('## v1.1.0'))
  })

  test('refuses to follow a next link off the GitHub API host', async () => {
    const requests: string[] = []
    await generateReleaseNotesPage({
      token: 'secret-token',
      fetchImpl: async (url) => {
        requests.push(String(url))
        return jsonResponse([makeRelease()], {
          link: '<https://evil.example.com/steal>; rel="next"',
        })
      },
    })
    expect(requests).toHaveLength(1)
  })

  test('falls back to the stub when the API request fails', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const page = await generateReleaseNotesPage({
      token: 'secret-token',
      fetchImpl: async () => new Response('nope', { status: 500 }),
    })
    const warned = warn.mock.calls.flat().join(' ')
    warn.mockRestore()
    expect(warned).not.toContain('secret-token')
    expect(page).toContain(
      'https://github.com/marcusrbrown/systematic/releases',
    )
  })
})
