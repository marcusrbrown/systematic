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
 * Release bodies are untrusted input: HTML is stripped, MDX-significant braces
 * are escaped, non-https links are dropped (text kept), fences are balanced and
 * bodies are length-capped.
 *
 * Usage:
 *   bun docs/scripts/generate-release-notes.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

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
const MAX_BODY_CHARS = 20000
/** Bodies without this heading were not narrated by Fro Bot. */
const NARRATIVE_MARKER = /^ {0,3}##[ \t]+What['’]s new\b/im
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
    const response = await fetchImpl(url, { headers })
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
  return releases
}

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

function isHttps(url: string): boolean {
  return /^https:\/\//i.test(url)
}

const INLINE_LINK =
  /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))*)((?:\s+(?:"[^"]*"|'[^']*'))?)\s*\)/g
const HTML_CONSTRUCT =
  /<\/?[A-Za-z][^<>]*>|<!--[\s\S]*?-->|<![^<>]*>|<\?[^<>]*>/g
const INLINE_CODE = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g

/** Keep https links; reduce everything else to its text. */
function filterLinks(line: string): string {
  return line
    .replace(/<(https:\/\/[^\s<>]+)>/gi, '$1')
    .replace(INLINE_LINK, (_match, bang, text, rawUrl, title) => {
      const url = String(rawUrl).replace(/^<|>$/g, '')
      return isHttps(url) ? `${bang}[${text}](${url}${title})` : String(text)
    })
}

/** Sanitize prose that is not inside a code span. */
function sanitizeProse(segment: string): string {
  let cleaned = segment
  let previous: string
  // Iterate to a fixed point so nested constructs like `<<b>script>` cannot
  // reassemble into a tag after one pass.
  do {
    previous = cleaned
    cleaned = cleaned.replace(HTML_CONSTRUCT, '')
  } while (cleaned !== previous)
  return cleaned.replace(/</g, '\\<').replace(/(?<!\\)([{}])/g, '\\$1')
}

function sanitizeInline(line: string): string {
  const linked = filterLinks(line)
  let result = ''
  let last = 0
  for (const match of linked.matchAll(INLINE_CODE)) {
    const start = match.index ?? 0
    result += sanitizeProse(linked.slice(last, start)) + match[0]
    last = start + match[0].length
  }
  return result + sanitizeProse(linked.slice(last))
}

type BodyLine =
  | { kind: 'code'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'heading'; level: number; text: string }

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/
const HORIZONTAL_RULE = /^ {0,3}([*_-][ \t]*){3,}$/
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:[ \t]*<?(\S*?)>?(?:[ \t]|$)/

function isSetextCandidate(line: string): boolean {
  return (
    line.trim() !== '' &&
    !/^( {4}|\t)/.test(line) &&
    !/^ {0,3}([#>*+|-]|\d+[.)]\s|`{3}|~{3})/.test(line)
  )
}

function cleanHeadingText(raw: string): string {
  const text = sanitizeInline(raw.replace(/[ \t]+#+$/, ''))
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!]+$/, '')
    .trim()
  return text === '' ? 'Untitled' : text
}

interface Fence {
  marker: string
  char: string
  /** Opening line, reduced to marker + language word. */
  opening: string
}

function matchFenceOpen(line: string): Fence | null {
  const open = line.match(FENCE_OPEN)
  const marker = open?.[1]
  if (marker == null) return null
  const info = open?.[2] ?? ''
  // A backtick fence's info string cannot contain a backtick (inline code).
  if (marker.startsWith('`') && info.includes('`')) return null
  // Keep only the language word; fence metadata is not needed here.
  const lang = info.trim().match(/^[\w+#.-]*/)?.[0] ?? ''
  return { marker, char: marker.charAt(0), opening: `${marker}${lang}` }
}

function closesFence(line: string, fence: Fence): boolean {
  const marker = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1]
  return (
    marker?.startsWith(fence.char) === true &&
    marker.length >= fence.marker.length
  )
}

/**
 * Parse one line outside a fence. `consumedNext` is set when a setext
 * underline on the following line was folded into a heading.
 */
function parseProseLine(
  line: string,
  nextLine: string,
): { parsed: BodyLine | null; consumedNext: boolean } {
  const definition = line.match(REFERENCE_DEFINITION)
  if (definition != null) {
    const kept = isHttps(definition[1] ?? '')
    return {
      parsed: kept ? { kind: 'text', text: sanitizeInline(line) } : null,
      consumedNext: false,
    }
  }

  const atx = line.match(ATX_HEADING)
  if (atx?.[1] != null && atx[2] != null) {
    return {
      parsed: {
        kind: 'heading',
        level: atx[1].length,
        text: cleanHeadingText(atx[2]),
      },
      consumedNext: false,
    }
  }

  const underline = nextLine.match(SETEXT_UNDERLINE)?.[1]
  if (underline != null && isSetextCandidate(line)) {
    return {
      parsed: {
        kind: 'heading',
        level: underline.startsWith('=') ? 1 : 2,
        text: cleanHeadingText(line.trim()),
      },
      consumedNext: true,
    }
  }

  // Normalize bullet markers so lists stay consistent across releases.
  const normalized = HORIZONTAL_RULE.test(line)
    ? line
    : line.replace(/^(\s*)[*+](\s+)/, '$1-$2')
  return {
    parsed: { kind: 'text', text: sanitizeInline(normalized) },
    consumedNext: false,
  }
}

/** Split a body into code, prose and heading lines, sanitizing as it goes. */
function parseBody(body: string): BodyLine[] {
  const rawLines = body.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n')
  const lines: BodyLine[] = []
  let fence: Fence | null = null

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i] ?? ''

    if (fence != null) {
      if (closesFence(line, fence)) {
        lines.push({ kind: 'code', text: fence.marker })
        fence = null
      } else {
        lines.push({ kind: 'code', text: line })
      }
      continue
    }

    fence = matchFenceOpen(line)
    if (fence != null) {
      lines.push({ kind: 'code', text: fence.opening })
      continue
    }

    const { parsed, consumedNext } = parseProseLine(line, rawLines[i + 1] ?? '')
    if (parsed != null) lines.push(parsed)
    if (consumedNext) i++
  }

  // An unterminated fence must not swallow whatever follows this body.
  if (fence != null) lines.push({ kind: 'code', text: fence.marker })
  return lines
}

/**
 * Shift body headings so the shallowest one sits directly under the version
 * heading, and never skip a level (markdownlint MD001).
 */
function renderBodyLines(lines: BodyLine[]): string {
  const levels = lines.flatMap((l) => (l.kind === 'heading' ? [l.level] : []))
  const shift =
    levels.length === 0 ? 0 : VERSION_HEADING_LEVEL + 1 - Math.min(...levels)
  let previousLevel = VERSION_HEADING_LEVEL

  const rendered = lines.map((line) => {
    if (line.kind !== 'heading') return line.text
    const level = Math.min(
      Math.max(line.level + shift, VERSION_HEADING_LEVEL + 1),
      previousLevel + 1,
      6,
    )
    previousLevel = level
    return `${'#'.repeat(level)} ${line.text}`
  })

  return rendered
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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
  const heading = cleanHeadingText(release.tag_name || release.name || '')
  const url = isHttps(release.html_url) ? release.html_url : RELEASES_PAGE_URL
  const rawBody = release.body ?? ''
  const { text, truncated } = capBody(rawBody.replace(/\r\n?/g, '\n'))
  const body = renderBodyLines(parseBody(text))

  const parts = [
    `## ${heading}`,
    `Published ${formatDate(release.published_at ?? release.created_at)} · Updated ${formatDate(release.updated_at)} · [View on GitHub](${url})`,
  ]
  if (!NARRATIVE_MARKER.test(rawBody)) {
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
