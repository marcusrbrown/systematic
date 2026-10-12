#!/usr/bin/env bun
/**
 * Generate the docs "Release notes" page from GitHub Releases.
 *
 * Fetches every published release of marcusrbrown/systematic (newest first) and
 * renders each release body — Fro Bot's narrative, which starts with
 * `## What's new` — into a plain `.md` page. A plain `.md` page (not `.mdx`)
 * means MDX never evaluates release content.
 *
 * Without GH_TOKEN / GITHUB_TOKEN no request is made and a stub page linking to
 * GitHub Releases is written instead, so the docs build never depends on the
 * network.
 *
 * Release bodies are untrusted input. Each is length-capped, parsed with
 * remark (CommonMark + GFM), rewritten on the syntax tree and re-serialized:
 * raw HTML and images are removed (alt text kept), links survive only with an
 * https URL, headings are demoted under the version heading, and braces are
 * escaped. The page is plain `.md`, so MDX never evaluates it.
 *
 * Usage:
 *   bun docs/scripts/generate-release-notes.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const OUTPUT_PATH = path.join(
  __dirname,
  '../src/content/docs/reference/release-notes.md',
)

const REPO = 'marcusrbrown/systematic'
const RELEASES_PAGE_URL = `https://github.com/${REPO}/releases`
const API_ORIGIN = 'https://api.github.com/'
const API_RELEASES_URL = `${API_ORIGIN}repos/${REPO}/releases?per_page=100`
const MAX_PAGES = 50
/** Per-request cap so a stalled GitHub API call fails fast into the stub page. */
const FETCH_TIMEOUT_MS = 15_000
const MAX_BODY_CHARS = 20000
/**
 * A body is narrated only when it starts with exactly this string. This must
 * match NARRATIVE_MARKER in scripts/dispatch-release-notes.sh, which is the
 * authority: no leading whitespace, ASCII apostrophe, at the very start.
 */
const NARRATIVE_MARKER = "## What's new"
/** Version headings are h2; body headings nest from h3 downwards. */
const VERSION_HEADING_LEVEL = 2

export interface GithubRelease {
  tag_name: string
  name: string | null
  body: string | null
  draft: boolean
  prerelease: boolean
  published_at: string | null
  created_at: string
  updated_at: string
  html_url: string
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function toRelease(value: unknown): GithubRelease | null {
  if (!isRecord(value) || typeof value.tag_name !== 'string') return null
  return {
    tag_name: value.tag_name,
    name: stringOrNull(value.name),
    body: stringOrNull(value.body),
    draft: value.draft === true,
    prerelease: value.prerelease === true,
    published_at: stringOrNull(value.published_at),
    created_at: stringOrNull(value.created_at) ?? '',
    updated_at: stringOrNull(value.updated_at) ?? '',
    html_url: stringOrNull(value.html_url) ?? RELEASES_PAGE_URL,
  }
}

/**
 * Extract the `rel="next"` URL from a Link header. The token is sent to
 * whatever URL this returns, so anything off the GitHub API origin is ignored.
 */
function nextPageUrl(linkHeader: string | null): string | null {
  if (linkHeader == null) return null
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    const url = match?.[1]
    if (url?.startsWith(API_ORIGIN)) return url
  }
  return null
}

export async function fetchReleases(
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<GithubRelease[]> {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'systematic-docs-release-notes',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const releases: GithubRelease[] = []
  let url: string | null = API_RELEASES_URL

  for (let page = 0; url != null && page < MAX_PAGES; page++) {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`GitHub API responded ${response.status} for ${url}`)
    }
    const data: unknown = await response.json()
    if (!Array.isArray(data)) {
      throw new Error(`GitHub API returned a non-array payload for ${url}`)
    }
    for (const item of data) {
      const release = toRelease(item)
      if (release != null) releases.push(release)
    }
    url = nextPageUrl(response.headers.get('link'))
  }
  // A silent stop here would publish a page that quietly omits older releases.
  if (url != null) {
    throw new Error(
      `GitHub API page limit (${MAX_PAGES}) reached; more pages remain`,
    )
  }
  return releases
}

const parser = unified().use(remarkParse).use(remarkGfm)

/**
 * Plain Markdown out: bullets, emphasis and fences are fixed so every body —
 * and the lint rules that check consistency across the page — sees one style.
 * `{` and `}` are escaped in prose so the text stays inert even if the page is
 * ever renamed to `.mdx`.
 */
const stringifier = unified()
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: '-',
    emphasis: '_',
    strong: '*',
    fences: true,
    rule: '-',
    listItemIndent: 'one',
    unsafe: [{ character: '{' }, { character: '}' }],
  })

type Root = ReturnType<typeof parser.parse>

/** Parse Markdown the way the docs site will (CommonMark + GFM). */
export function parseMarkdown(markdown: string): MdNode {
  return parser.parse(markdown) as unknown as MdNode
}

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of an mdast node. The sanitizer rewrites the tree in
 * place and in ways the strict per-node mdast types do not model (splicing
 * phrasing content into parents), so it works on this shape and casts at the
 * parse/stringify boundary.
 */
export interface MdNode {
  type: string
  children?: MdNode[]
  value?: string
  url?: string
  title?: string | null
  alt?: string | null
  depth?: number
  identifier?: string
  lang?: string | null
  meta?: string | null
}

interface SanitizeState {
  /** First definition wins, as in CommonMark. */
  definitions: Map<string, string>
  /** Added to every body heading depth. */
  shift: number
  previousLevel: number
}

function isHttps(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

function walk(node: MdNode, visit: (node: MdNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function prepareState(root: MdNode): SanitizeState {
  const definitions = new Map<string, string>()
  const depths: number[] = []
  walk(root, (node) => {
    if (node.type === 'heading') depths.push(node.depth ?? 1)
    if (
      node.type === 'definition' &&
      node.identifier != null &&
      node.url != null &&
      !definitions.has(node.identifier)
    ) {
      definitions.set(node.identifier, node.url)
    }
  })
  // The shallowest body heading becomes one level below the version heading.
  const shift =
    depths.length === 0 ? 0 : VERSION_HEADING_LEVEL + 1 - Math.min(...depths)
  return { definitions, shift, previousLevel: VERSION_HEADING_LEVEL }
}

/**
 * Text that GFM would autolink on render: `http://` URLs, `www.` hosts,
 * `mailto:`/`xmpp:` and bare email addresses. Autolinking would create links
 * that were never in the AST this sanitizer vetted (and so bypass the https
 * rule), so these spans are emitted as inline code instead. https URLs are
 * left alone: they autolink to an https link, which is allowed.
 */
const AUTOLINK_LITERAL =
  /http:\/\/\S*|www\.\S*|(?:mailto|xmpp):\S*|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi

function neutralizeAutolinks(value: string): MdNode[] {
  const nodes: MdNode[] = []
  let last = 0
  for (const match of value.matchAll(AUTOLINK_LITERAL)) {
    const start = match.index ?? 0
    nodes.push(...textNode(value.slice(last, start)))
    nodes.push({ type: 'inlineCode', value: match[0] })
    last = start + match[0].length
  }
  return [...nodes, ...textNode(value.slice(last))]
}

function textNode(value: string | null | undefined): MdNode[] {
  return value == null || value === '' ? [] : [{ type: 'text', value }]
}

function sanitizeChildren(node: MdNode, state: SanitizeState): void {
  if (node.children == null) return
  node.children = node.children.flatMap((child) => sanitizeNode(child, state))
}

function keepLink(
  node: MdNode,
  url: string,
  state: SanitizeState,
): MdNode | null {
  sanitizeChildren(node, state)
  if (!isHttps(url)) return null
  const children = node.children?.length ? node.children : textNode(url)
  return { type: 'link', url, title: null, children }
}

function sanitizeHeading(node: MdNode, state: SanitizeState): MdNode {
  const level = Math.min(
    Math.max((node.depth ?? 1) + state.shift, VERSION_HEADING_LEVEL + 1),
    state.previousLevel + 1,
    6,
  )
  state.previousLevel = level
  node.depth = level
  sanitizeChildren(node, state)

  const last = node.children?.at(-1)
  if (last?.type === 'text' && last.value != null) {
    last.value = last.value.replace(/[.,;:!]+$/, '')
  }
  const empty = (node.children ?? []).every(
    (child) => child.type === 'text' && (child.value ?? '') === '',
  )
  if (empty) node.children = textNode('Untitled')
  return node
}

/**
 * Rewrite one node, returning the nodes that replace it:
 * - raw HTML and definitions are removed;
 * - images become their alt text;
 * - links (and reference links, resolved through their definition) survive
 *   only when the URL is https, otherwise they unwrap to their content;
 * - code stays as it is — it renders as code, never as HTML.
 */
function sanitizeNode(node: MdNode, state: SanitizeState): MdNode[] {
  switch (node.type) {
    case 'html':
    case 'definition':
      return []
    case 'text':
      return neutralizeAutolinks(node.value ?? '')
    case 'image':
    case 'imageReference':
      return textNode(node.alt)
    case 'link': {
      const link = keepLink(node, node.url ?? '', state)
      return link == null ? (node.children ?? []) : [link]
    }
    case 'linkReference': {
      const url = state.definitions.get(node.identifier ?? '') ?? ''
      const link = keepLink(node, url, state)
      return link == null ? (node.children ?? []) : [link]
    }
    case 'heading':
      return [sanitizeHeading(node, state)]
    case 'code': {
      // The info string is free text; keep only a plain language word.
      node.lang = /^[\w+#.-]+$/.test(node.lang ?? '') ? node.lang : null
      node.meta = null
      return [node]
    }
    default:
      sanitizeChildren(node, state)
      return [node]
  }
}

function stringifyNodes(children: MdNode[]): string {
  const root = { type: 'root', children } as unknown as Root
  return stringifier
    .stringify(root)
    .replace(/\t/g, '  ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Parse an untrusted Markdown body, strip anything unsafe, re-serialize it. */
function sanitizeBody(body: string): string {
  const root = parseMarkdown(body)
  sanitizeChildren(root, prepareState(root))
  return stringifyNodes(root.children ?? [])
}

/** Cap oversized bodies on a line (or word) boundary. */
function capBody(body: string): { text: string; truncated: boolean } {
  if (body.length <= MAX_BODY_CHARS) return { text: body, truncated: false }
  const head = body.slice(0, MAX_BODY_CHARS)
  const newline = head.lastIndexOf('\n')
  const space = head.lastIndexOf(' ')
  const cut =
    newline > MAX_BODY_CHARS / 2 ? newline : space > 0 ? space : MAX_BODY_CHARS
  return { text: head.slice(0, cut), truncated: true }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const PAGE_FRONTMATTER = {
  title: 'Release notes',
  description:
    'Every published Systematic release with its Fro Bot narrative, newest first.',
  tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 2 },
}

function renderPage(body: string): string {
  const fm = yaml.dump(PAGE_FRONTMATTER, { lineWidth: -1 }).trim()
  return `---\n${fm}\n---\n\n${body.trim()}\n`
}

export function renderStubPage(): string {
  return renderPage(
    `Release notes are published on [GitHub Releases](${RELEASES_PAGE_URL}). They are not embedded in this build.`,
  )
}

function formatDate(iso: string | null): string {
  return iso?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? 'unknown'
}

function releaseTime(release: GithubRelease): number {
  const time = Date.parse(release.published_at ?? release.created_at)
  return Number.isNaN(time) ? 0 : time
}

function renderRelease(release: GithubRelease): string {
  const url = isHttps(release.html_url)
    ? new URL(release.html_url).href
    : RELEASES_PAGE_URL
  const rawBody = release.body ?? ''
  const { text, truncated } = capBody(rawBody.replace(/\r\n?/g, '\n'))
  const body = sanitizeBody(text)

  // Header text comes from the API too, so it is built as syntax-tree nodes and
  // serialized, never interpolated into Markdown.
  const heading = stringifyNodes([
    {
      type: 'heading',
      depth: VERSION_HEADING_LEVEL,
      children: textNode(release.tag_name || release.name || 'Untitled'),
    },
  ])
  const meta = stringifyNodes([
    {
      type: 'paragraph',
      children: [
        ...textNode(
          `Published ${formatDate(release.published_at ?? release.created_at)} · Updated ${formatDate(release.updated_at)} · `,
        ),
        {
          type: 'link',
          url,
          children: textNode('View on GitHub'),
        },
      ],
    },
  ])

  const parts = [heading, meta]
  if (!rawBody.startsWith(NARRATIVE_MARKER)) {
    parts.push(
      '> **Narrative unavailable.** No Fro Bot narrative was published for this release; the notes below are the raw release body.',
    )
  }
  parts.push(body === '' ? 'No release notes were published.' : body)
  if (truncated) {
    parts.push(
      `Release notes truncated at ${MAX_BODY_CHARS.toLocaleString('en-US')} characters. [Read the full release on GitHub](${url}).`,
    )
  }
  return parts.join('\n\n')
}

export function renderReleaseNotesPage(releases: GithubRelease[]): string {
  const published = releases
    .filter((release) => !release.draft && !release.prerelease)
    .sort((a, b) => releaseTime(b) - releaseTime(a))

  const intro = `Every published release of Systematic, newest first. Narratives are written by Fro Bot; see also [GitHub Releases](${RELEASES_PAGE_URL}).`
  if (published.length === 0) {
    return renderPage(`${intro}\n\nNo releases have been published yet.`)
  }
  return renderPage([intro, ...published.map(renderRelease)].join('\n\n'))
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function generateReleaseNotesPage(options: {
  token: string | undefined
  fetchImpl?: FetchLike
}): Promise<string> {
  const token = options.token?.trim()
  if (token == null || token === '') return renderStubPage()

  try {
    return renderReleaseNotesPage(
      await fetchReleases(token, options.fetchImpl ?? fetch),
    )
  } catch (error) {
    // Never fail the docs build over release notes, and never echo the token.
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`⚠️  Release notes unavailable, writing stub page: ${reason}`)
    return renderStubPage()
  }
}

if (import.meta.main) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (token == null || token === '') {
    console.log('No GH_TOKEN/GITHUB_TOKEN set; writing stub release notes page')
  }
  const page = await generateReleaseNotesPage({ token })
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
  fs.writeFileSync(OUTPUT_PATH, page)
  console.log(`✓ Generated release notes page: ${OUTPUT_PATH}`)
}
