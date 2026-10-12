import { describe, expect, spyOn, test } from 'bun:test'
import path from 'node:path'
import yaml from 'js-yaml'
import {
  fetchReleases,
  type GithubRelease,
  generateReleaseNotesPage,
  type MdNode,
  OUTPUT_PATH,
  parseMarkdown,
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
  const cliDir = path.dirname(
    Bun.resolveSync('markdownlint-cli/package.json', import.meta.dir),
  )
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

/**
 * Output-safety property: re-parse a page the way the docs site will and list
 * every node that must never reach a reader — raw HTML, images, and links or
 * definitions whose URL is not https (autolink literals included).
 */
function unsafeNodes(markdown: string): string[] {
  const found: string[] = []
  const visit = (node: MdNode) => {
    if (node.type === 'html') found.push('html')
    if (node.type === 'image' || node.type === 'imageReference') {
      found.push(node.type)
    }
    if (
      (node.type === 'link' || node.type === 'definition') &&
      !/^https:/i.test(node.url ?? '')
    ) {
      found.push(`${node.type}:${node.url}`)
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(parseMarkdown(markdown))
  return found
}

const HOSTILE_CORPUS: Record<string, string> = {
  script: "## What's new\n\n<script>alert(1)</script>\n\nafter",
  braces: "## What's new\n\nLeak {process.env.SECRET} and {{ x }}.",
  javascriptLink: "## What's new\n\n[x](javascript:alert(1))",
  dataLink: "## What's new\n\n[x](data:text/html;base64,AAAA)",
  vbscriptLink: "## What's new\n\n[x](vbscript:msgbox(1))",
  httpLink: "## What's new\n\n[x](http://example.com/a)",
  relativeLink: "## What's new\n\n[x](/relative) [y](#frag)",
  nestedBrackets: "## What's new\n\n[a [b] c](javascript:alert(1))",
  multilineLinkText: "## What's new\n\n[click\nme](javascript:alert(1))",
  referenceLink:
    "## What's new\n\n[x][ref] and [ref] and [y][ok]\n\n[ref]: javascript:alert(1)\n[ok]: https://example.com/ok",
  httpReferenceDefinition:
    "## What's new\n\n[x][ref]\n\n[ref]: http://example.com",
  autolinkJavascript: "## What's new\n\n<javascript:alert(1)>",
  autolinkMailto: "## What's new\n\n<mailto:a@example.com> and a@example.com",
  autolinkHttp: "## What's new\n\n<http://example.com/x>",
  bareHttp: "## What's new\n\nSee http://example.com and www.example.com.",
  escapedBacktick: "## What's new\n\n\\`<img src=x onerror=alert(1)>`",
  escapedBacktickBlock:
    "## What's new\n\n\\`<img src=x onerror=alert(1)>` and \\`<script>alert(2)</script>`",
  httpsImage: "## What's new\n\n![tracker](https://tracker.example/x.png)",
  imageReference:
    "## What's new\n\n![alt][img]\n\n[img]: https://tracker.example/y.png",
  imageInLink:
    "## What's new\n\n[![alt](https://t.example/i.png)](javascript:alert(1))",
  htmlBlocks:
    "## What's new\n\n<div onclick=alert(1)>\n\nhi\n\n</div>\n\n<!-- c -->\n\n<details><summary>s</summary>x</details>",
  fenceWithHtml:
    "## What's new\n\n```html\n<script>alert(1)</script>\n```\n\n`<img src=x>`",
  unterminatedFence: "## What's new\n\n```js\n<script>alert(1)</script>",
  tableWithLinks:
    "## What's new\n\n| a | b |\n| - | - |\n| [x](javascript:1) | http://e.com |",
  footnote: "## What's new\n\nText[^1].\n\n[^1]: see <b>this</b> http://e.com",
  setextHeading: 'Title\n=====\n\nbody',
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

  test('output is a plain .md page so MDX never evaluates it', () => {
    expect(path.extname(OUTPUT_PATH)).toBe('.md')
  })

  test.each([
    ['mermaid', 'mermaid'],
    ['Mermaid', 'Mermaid'],
    ['MERMAID', 'MERMAID'],
  ])(
    'a %s fence renders as a plain code block, never a diagram',
    (_name, lang) => {
      const diagram = 'graph TD\n  A --> --> B[unclosed'
      const page = renderReleaseNotesPage([
        makeRelease({
          body: `## What's new\n\n\`\`\`${lang}\n${diagram}\n\`\`\`\n`,
        }),
      ])
      expect(page).not.toMatch(/mermaid/i)
      expect(page).toContain(`\`\`\`\n${diagram}\n\`\`\``)
    },
  )

  test('keeps other language words on code fences', () => {
    const page = renderReleaseNotesPage([
      makeRelease({ body: "## What's new\n\n```ts\nconst x = 1\n```\n" }),
    ])
    expect(page).toContain('```ts\nconst x = 1\n```')
  })

  test('drops javascript: links with nested brackets in the link text', () => {
    const page = renderReleaseNotesPage([
      makeRelease({ body: "## What's new\n\n[a [b] c](javascript:alert(1))" }),
    ])
    expect(page).not.toMatch(/javascript:/i)
    expect(page).toMatch(/a \\?\[b\] c/)
  })

  test('drops javascript: links whose text spans a line break', () => {
    const page = renderReleaseNotesPage([
      makeRelease({
        body: "## What's new\n\n[click\nme](javascript:alert(1))",
      }),
    ])
    expect(page).not.toMatch(/javascript:/i)
    expect(page).toMatch(/click\s+me/)
  })

  test('an escaped backtick cannot open a fake code span around raw HTML', () => {
    const page = renderReleaseNotesPage([
      makeRelease({
        body: "## What's new\n\n\\`<img src=x onerror=alert(1)>`",
      }),
    ])
    expect(page).not.toMatch(/<img/i)
    expect(unsafeNodes(page)).toEqual([])
  })

  test('drops https images and keeps their alt text', () => {
    const page = renderReleaseNotesPage([
      makeRelease({
        body: "## What's new\n\n![a tracker pixel](https://tracker.example/x.png)",
      }),
    ])
    expect(page).not.toContain('tracker.example')
    expect(page).not.toContain('![')
    expect(page).toContain('a tracker pixel')
  })

  test('bare http URLs are not re-autolinked when the page renders', () => {
    const page = renderReleaseNotesPage([
      makeRelease({
        body: "## What's new\n\nSee http://example.com/a and <http://example.org/b>.",
      }),
    ])
    expect(unsafeNodes(page)).toEqual([])
    expect(page).toContain('example.com/a')
  })

  test.each([
    ['curly apostrophe', '## What\u2019s new\n\nbody'],
    ['indented heading', " ## What's new\n\nbody"],
    ['heading mid-body', "intro\n\n## What's new\n\nbody"],
    ['leading blank line', "\n## What's new\n\nbody"],
    ['lowercase', "## what's new\n\nbody"],
  ])('narrative marker must be the exact body prefix: %s', (_name, body) => {
    const page = renderReleaseNotesPage([makeRelease({ body })])
    expect(page).toContain('Narrative unavailable')
  })

  test('a body starting with the exact marker is narrated', () => {
    const page = renderReleaseNotesPage([
      makeRelease({ body: "## What's new\n\nbody" }),
    ])
    expect(page).not.toContain('Narrative unavailable')
  })

  for (const [name, body] of Object.entries(HOSTILE_CORPUS)) {
    test(`output-safety property holds for hostile body: ${name}`, () => {
      const page = renderReleaseNotesPage([
        makeRelease({ body }),
        makeRelease({
          tag_name: 'v0.1.0',
          name: 'v0.1.0',
          published_at: '2025-01-01T00:00:00Z',
          body: null,
        }),
      ])
      expect(unsafeNodes(page)).toEqual([])
    })
  }

  test('output-safety property holds for randomly combined hostile fragments', () => {
    const fragments = [
      '[a](javascript:alert(1))',
      '[a [b] c](vbscript:x)',
      '[x][r]',
      '[r]: http://e.example',
      '![i](https://t.example/p.png)',
      '![i][r]',
      '<script>alert(1)</script>',
      '<img src=x onerror=1>',
      '<javascript:alert(1)>',
      '<http://e.example>',
      'http://e.example/a',
      'www.e.example',
      'a@e.example',
      '\\`<b>x</b>`',
      '`code <b>`',
      '```',
      '~~~html',
      '<!--',
      '-->',
      '{x}',
      '| a | b |\n| - | - |\n| http://e.example | [l](data:x) |',
      '> quote [q](javascript:1)',
      '- item <i>i</i>',
      '# H1',
      '#### H4 {y}',
      'Setext\n===',
      '[^1]: note http://e.example',
      '[^1]',
      '',
      '',
    ]
    let seed = 1337
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    for (let i = 0; i < 400; i++) {
      const count = 1 + Math.floor(next() * 8)
      const separators = ['\n', '\n\n', ' ', '']
      let body = ''
      for (let j = 0; j < count; j++) {
        body += fragments[Math.floor(next() * fragments.length)] ?? ''
        body += separators[Math.floor(next() * separators.length)] ?? ''
      }
      const page = renderReleaseNotesPage([makeRelease({ body })])
      expect({ body, found: unsafeNodes(page) }).toEqual({ body, found: [] })
    }
  })

  test('output-safety property holds for hostile release metadata', () => {
    const page = renderReleaseNotesPage([
      makeRelease({
        tag_name: '<img src=x onerror=1>{evil}\n## injected',
        name: 'x',
        html_url: 'javascript:alert(1)',
        published_at: '<script>',
        updated_at: 'http://example.com',
      }),
    ])
    expect(unsafeNodes(page)).toEqual([])
    expect(page).not.toMatch(/^## injected/m)
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

  test('passes an AbortSignal timeout to every request so a stalled fetch cannot hang the build', async () => {
    const signals: Array<AbortSignal | null | undefined> = []
    await generateReleaseNotesPage({
      token: 'secret-token',
      fetchImpl: async (_url, init) => {
        signals.push(init?.signal)
        return jsonResponse([makeRelease()])
      },
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[0]?.aborted).toBe(false)
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

  test('throws instead of silently stopping at the page limit', async () => {
    let calls = 0
    const endless = async () => {
      calls++
      return jsonResponse([makeRelease()], {
        link: `<https://api.github.com/repositories/1/releases?page=${calls + 1}>; rel="next"`,
      })
    }
    await expect(fetchReleases('t', endless)).rejects.toThrow(/page limit/i)

    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const page = await generateReleaseNotesPage({
      token: 't',
      fetchImpl: endless,
    })
    warn.mockRestore()
    expect(page).toContain('not embedded in this build')
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
