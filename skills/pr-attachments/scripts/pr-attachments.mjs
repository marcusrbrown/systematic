#!/usr/bin/env node

// Helper for the pr-attachments skill: the gates that must be exact.
//
// Every subcommand reads one JSON object on stdin and writes one JSON object
// on stdout. None prints file or body contents, and each only reports paths
// the caller gave it. A PR body is decoded once, from the JSON string. A body
// the helper produces goes to the file named by `out_file`, never to stdout,
// and nothing else is written.
//
// Usage:
//   node pr-attachments.mjs classify       < input.json
//   node pr-attachments.mjs splice         < input.json
//   node pr-attachments.mjs extract        < input.json
//   node pr-attachments.mjs urls           < input.json
//   node pr-attachments.mjs repin-rewrite  < input.json
//
// classify sorts explicit image paths into accepted entries with destination
// names, or rejects the whole batch.
//   paths        non-empty array of image file paths (relative to the cwd)
//   branch       branch name, used for the topic when `topic` is empty
//   topic        optional user-supplied topic; wins over `branch`
//   existing     optional map of destination path -> git blob SHA already
//                present at that path on the head commit
//   max_bytes    optional size limit, default 100 MiB (injectable for tests)
//   warn_bytes   optional soft size, default 10 MiB (injectable for tests)
//
// splice puts a `## Demo` section into a PR body, replacing the one that is
// there or appending one, and leaves every byte outside it identical.
//   body         the PR body
//   demo_file    file holding the Demo section: one `## Demo` heading and its
//                content, nothing else (`extract` output is valid input)
//   out_file     where the new body is written
//
// extract writes the existing `## Demo` section, heading through its last
// non-blank line, to `out_file`, or reports `absent`.
//   body, out_file
//
// urls lists the managed embed URLs in a body. A URL is managed only when it
// is a raw or blob URL for `head_repo` whose path is
// docs/evidence/<slug>/<name> with a whitelisted slug and name.
//   body, head_repo ("owner/repo")
//
// repin-rewrite replaces only the 40-hex ref of managed URLs, so captions and
// hand edits stay as they are.
//   body, head_repo, out_file
//   pins         map of managed path -> new 40-hex lower-case SHA
//
// Section rules (no markers; the heading is the only boundary):
//   - The heading matches ^ {0,3}##[ \t]+Demo([ \t]+#+)?[ \t]*$.
//   - A section runs to the next H1 or H2 (ATX or setext) or to the end.
//   - Fenced code (an unclosed fence runs to the end), multi-line HTML
//     comments and block quotes hide headings; so does indented code.
//   - Trailing blank lines belong to the gap after a section, not to it.
//   - Lines split on CRLF, LF or CR and keep their terminators. Lines the
//     helper inserts use the body's dominant terminator; Demo text is
//     inserted verbatim.
//
// Exit codes: 0 success, 1 domain failure (rejected batch, or a question
// the user must answer, or an output file that cannot be written), 2 usage
// error.

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SCHEMA_VERSION = 1
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
const DEFAULT_WARN_BYTES = 10 * 1024 * 1024
const MAX_SLUG_LENGTH = 60
const EVIDENCE_ROOT = 'docs/evidence'
const SVG_MESSAGE = 'SVG is not supported by this skill'
const USAGE =
  'node pr-attachments.mjs <classify|splice|extract|urls|repin-rewrite> < input.json'

const EXTENSIONS = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' }

const REJECTION_MESSAGES = {
  missing: 'The path does not exist',
  unreadable: 'The file cannot be read',
  'not-a-file': 'The path is not a regular file',
  'too-large': 'The file is over the size limit',
  'svg-not-supported': SVG_MESSAGE,
  'unsupported-type': 'The file is not a PNG, JPEG, GIF or WebP image',
}

// ── Format detection ───────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

// An optional BOM and prolog (XML declaration, comments, doctype with an
// optional internal subset) may precede the root element.
const SVG_PATTERN =
  /^\uFEFF?\s*(?:<\?xml[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>\s*)*<svg[\s>/]/i

/**
 * Detects the format from magic bytes only, never from the file name.
 * @param {Buffer} bytes
 * @returns {'png' | 'jpeg' | 'gif' | 'webp' | 'svg' | 'unknown'}
 */
function detectType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'png'
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'jpeg'
  }
  const head = bytes.toString('latin1', 0, 6)
  if (head === 'GIF87a' || head === 'GIF89a') {
    return 'gif'
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  if (SVG_PATTERN.test(bytes.toString('utf8', 0, 4096))) {
    return 'svg'
  }
  return 'unknown'
}

// ── Naming ─────────────────────────────────────────────────────────────────

/**
 * The topic slug: NFKC, lowercase, runs of anything outside [a-z0-9] become
 * one hyphen, trimmed, at most 60 characters. The output holds only
 * [a-z0-9-], never starts or ends with a hyphen, and may be empty.
 * @param {string} value
 */
export function slugTopic(value) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')
}

/**
 * The destination file stem: the same normalisation, over [a-z0-9._-].
 * Starts and ends with a letter or digit, and may be empty.
 * @param {string} stem
 */
export function slugName(stem) {
  return stem
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
}

/** @param {string} source */
function sourceStem(source) {
  const base = path.basename(source)
  return base.slice(0, base.length - path.extname(base).length)
}

// ── File inspection ────────────────────────────────────────────────────────

/** @param {Buffer} bytes */
function blobSha(bytes) {
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex')
}

/**
 * Opens without blocking, so a FIFO or device path cannot hang the helper.
 * @param {string} source
 * @param {number} maxBytes
 * @returns {{ ok: true, bytes: Buffer } | { ok: false, reason: string }}
 */
function readCandidate(source, maxBytes) {
  let fd
  try {
    fd = openSync(
      path.resolve(source),
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
    )
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    return {
      ok: false,
      reason:
        code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable',
    }
  }
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile()) {
      return { ok: false, reason: 'not-a-file' }
    }
    if (stats.size > maxBytes) {
      return { ok: false, reason: 'too-large' }
    }
    const bytes = Buffer.alloc(stats.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (read === 0) {
        break
      }
      offset += read
    }
    return { ok: true, bytes: bytes.subarray(0, offset) }
  } catch {
    return { ok: false, reason: 'unreadable' }
  } finally {
    closeSync(fd)
  }
}

/**
 * @param {string} source
 * @param {{ maxBytes: number, warnBytes: number }} limits
 */
function inspectFile(source, limits) {
  const candidate = readCandidate(source, limits.maxBytes)
  if (!candidate.ok) {
    return { source, rejection: candidate.reason }
  }
  const type = detectType(candidate.bytes)
  if (type === 'svg') {
    return { source, rejection: 'svg-not-supported' }
  }
  if (type === 'unknown') {
    return { source, rejection: 'unsupported-type' }
  }
  return {
    source,
    type,
    bytes: candidate.bytes.length,
    blobSha: blobSha(candidate.bytes),
    warnings: fileWarnings(source, type, candidate.bytes, limits),
  }
}

/**
 * @param {string} source
 * @param {string} type
 * @param {Buffer} bytes
 * @param {{ warnBytes: number }} limits
 */
function fileWarnings(source, type, bytes, limits) {
  const warnings = []
  const trailing = trailingBytes(type, bytes)
  if (trailing > 0) {
    warnings.push({ source, code: 'trailing-data', bytes: trailing })
  }
  if (bytes.length > limits.warnBytes) {
    warnings.push({ source, code: 'large-file', bytes: bytes.length })
  }
  return warnings
}

// ── Trailing data after the end of the image ───────────────────────────────
//
// Each walk follows the format's own structure to its end marker, so text
// that merely looks like a marker inside a chunk or segment is not taken for
// one. A file that cannot be walked to its end reports no trailing data.

/**
 * @param {string} type
 * @param {Buffer} bytes
 */
function trailingBytes(type, bytes) {
  switch (type) {
    case 'png':
      return pngTrailing(bytes)
    case 'jpeg':
      return jpegTrailing(bytes)
    case 'gif':
      return gifTrailing(bytes)
    case 'webp':
      return webpTrailing(bytes)
    default:
      return 0
  }
}

/** @param {Buffer} bytes */
function pngTrailing(bytes) {
  let pos = PNG_SIGNATURE.length
  while (pos + 12 <= bytes.length) {
    const end = pos + 12 + bytes.readUInt32BE(pos)
    if (end > bytes.length) {
      return 0
    }
    if (bytes.toString('latin1', pos + 4, pos + 8) === 'IEND') {
      return bytes.length - end
    }
    pos = end
  }
  return 0
}

/** @param {Buffer} bytes */
function jpegTrailing(bytes) {
  let pos = 2
  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) {
      return 0
    }
    const marker = bytes[pos + 1]
    if (marker === 0xff) {
      pos += 1
      continue
    }
    if (marker === 0xd9) {
      return bytes.length - (pos + 2)
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      pos += 2
      continue
    }
    if (pos + 4 > bytes.length) {
      return 0
    }
    const length = bytes.readUInt16BE(pos + 2)
    if (length < 2) {
      return 0
    }
    pos += 2 + length
    if (marker === 0xda) {
      pos = skipJpegScan(bytes, pos)
    }
  }
  return 0
}

/**
 * Skips entropy-coded data up to the next real marker: stuffed 0xFF00 bytes
 * and restart markers belong to the scan.
 * @param {Buffer} bytes
 * @param {number} start
 */
function skipJpegScan(bytes, start) {
  let pos = start
  while (pos + 1 < bytes.length) {
    if (bytes[pos] === 0xff) {
      const next = bytes[pos + 1]
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        pos += 2
        continue
      }
      if (next === 0xff) {
        pos += 1
        continue
      }
      return pos
    }
    pos += 1
  }
  return bytes.length
}

/** @param {Buffer} bytes */
function gifTrailing(bytes) {
  if (bytes.length < 13) {
    return 0
  }
  let pos = 13 + colorTableSize(bytes[10])
  while (pos < bytes.length) {
    const block = bytes[pos]
    if (block === 0x3b) {
      return bytes.length - (pos + 1)
    }
    if (block === 0x21) {
      pos = skipSubBlocks(bytes, pos + 2)
    } else if (block === 0x2c && pos + 10 <= bytes.length) {
      // Image descriptor, local color table, LZW code size, then data.
      pos = skipSubBlocks(bytes, pos + 10 + colorTableSize(bytes[pos + 9]) + 1)
    } else {
      return 0
    }
    if (pos < 0) {
      return 0
    }
  }
  return 0
}

/** @param {number} flags */
function colorTableSize(flags) {
  return flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0
}

/**
 * Returns the offset after the terminating empty sub-block, or -1.
 * @param {Buffer} bytes
 * @param {number} start
 */
function skipSubBlocks(bytes, start) {
  let pos = start
  while (pos < bytes.length) {
    const size = bytes[pos]
    pos += 1 + size
    if (size === 0) {
      return pos
    }
  }
  return -1
}

/** @param {Buffer} bytes */
function webpTrailing(bytes) {
  const end = 8 + bytes.readUInt32LE(4)
  return end <= bytes.length ? bytes.length - end : 0
}

// ── Classification ─────────────────────────────────────────────────────────

/**
 * @param {{
 *   paths: string[],
 *   branch?: string,
 *   topic?: string,
 *   existing: Record<string, string>,
 *   maxBytes: number,
 *   warnBytes: number,
 * }} input
 */
export function classify(input) {
  const limits = { maxBytes: input.maxBytes, warnBytes: input.warnBytes }
  const inspected = input.paths.map((source) => inspectFile(source, limits))
  const warnings = inspected.flatMap((file) => file.warnings ?? [])

  const topicSource =
    typeof input.topic === 'string' && input.topic.length > 0
      ? 'topic'
      : 'branch'
  const slug = slugTopic(
    (topicSource === 'topic' ? input.topic : input.branch) ?? '',
  )
  const topic = slug.length > 0 ? { slug, source: topicSource } : null

  const rejections = inspected
    .filter((file) => file.rejection !== undefined)
    .map((file) => ({
      source: file.source,
      reason: file.rejection,
      message: REJECTION_MESSAGES[file.rejection],
    }))
  if (rejections.length > 0) {
    return response('rejected', { topic, rejections, warnings })
  }

  const asks = collectAsks(inspected, topic, input.existing)
  if (asks.length > 0) {
    return response('needs-input', { topic, asks, warnings })
  }

  const entries = inspected.map((file) => ({
    source: file.source,
    destination: destinationFor(topic.slug, file),
    type: file.type,
    bytes: file.bytes,
    blob_sha: file.blobSha,
    status:
      input.existing[destinationFor(topic.slug, file)] === undefined
        ? 'new'
        : 'reused',
  }))
  return response('accepted', { topic, entries, warnings })
}

/**
 * @param {string} slug
 * @param {{ source: string, type: string }} file
 */
function destinationFor(slug, file) {
  const stem = slugName(sourceStem(file.source))
  return `${EVIDENCE_ROOT}/${slug}/${stem}.${EXTENSIONS[file.type]}`
}

/**
 * Everything the user must settle before anything is copied: an empty
 * topic, a source name that slugs to nothing, two inputs that map to one
 * destination, and a destination that already holds different bytes.
 * @param {Array<{ source: string, type: string, blobSha: string }>} files
 * @param {{ slug: string } | null} topic
 * @param {Record<string, string>} existing
 */
function collectAsks(files, topic, existing) {
  const asks = []
  if (topic === null) {
    asks.push({ code: 'empty-topic' })
  }
  const named = []
  for (const file of files) {
    if (slugName(sourceStem(file.source)).length === 0) {
      asks.push({ code: 'empty-name', source: file.source })
    } else if (topic !== null) {
      named.push({ file, destination: destinationFor(topic.slug, file) })
    }
  }
  const byDestination = new Map()
  for (const item of named) {
    const group = byDestination.get(item.destination) ?? []
    group.push(item)
    byDestination.set(item.destination, group)
  }
  for (const [destination, group] of byDestination) {
    if (group.length > 1) {
      asks.push({
        code: 'duplicate-destination',
        destination,
        sources: group.map((item) => item.file.source),
      })
    } else if (
      existing[destination] !== undefined &&
      existing[destination] !== group[0].file.blobSha
    ) {
      asks.push({
        code: 'destination-conflict',
        destination,
        sources: [group[0].file.source],
      })
    }
  }
  return asks
}

/**
 * @param {'accepted' | 'rejected' | 'needs-input'} result
 * @param {Record<string, unknown>} parts
 */
function response(result, parts) {
  return {
    exitCode: result === 'accepted' ? 0 : 1,
    body: {
      schema_version: SCHEMA_VERSION,
      operation: 'classify',
      result,
      topic: parts.topic ?? null,
      entries: parts.entries ?? [],
      rejections: parts.rejections ?? [],
      asks: parts.asks ?? [],
      warnings: parts.warnings ?? [],
    },
  }
}

// ── Markdown structure ─────────────────────────────────────────────────────
//
// Just enough of CommonMark to find H1/H2 boundaries and to know which lines
// are hidden from headings: fenced code, HTML comment blocks and block quotes.
// Indented code needs no tracking, because a heading has at most 3 leading
// spaces. Anything that is not a heading is left exactly as it is.

const DEMO_HEADING = /^ {0,3}##[ \t]+Demo(?:[ \t]+#+)?[ \t]*$/
const SCREENSHOTS_HEADING = /^ {0,3}##[ \t]+Screenshots(?:[ \t]+#+)?[ \t]*$/
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/
const THEMATIC_BREAK =
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const COMMENT_OPEN = /^ {0,3}<!--/
const BLOCK_QUOTE = /^ {0,3}>/
const NOT_INDENTED = /^ {0,3}[^ \t]/
const BLANK = /^[ \t]*$/
const LINE_BREAK = /\r\n|\n|\r/g
const ENDS_WITH_BREAK = /(?:\r\n|\n|\r)$/

/**
 * Splits on CRLF, LF or CR. Every line keeps its terminator's position, so
 * the lines tile the text exactly.
 * @param {string} text
 * @returns {Array<{ text: string, start: number, next: number, eol: string }>}
 */
function splitLines(text) {
  const lines = []
  let start = 0
  for (const match of text.matchAll(LINE_BREAK)) {
    lines.push({
      text: text.slice(start, match.index),
      start,
      next: match.index + match[0].length,
      eol: match[0],
    })
    start = match.index + match[0].length
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), start, next: text.length, eol: '' })
  }
  return lines
}

/**
 * The terminator used most often; the latest one wins a tie. Null when the
 * text has no terminator at all.
 * @param {Array<{ eol: string }>} lines
 */
function dominantEol(lines) {
  const seen = new Map()
  lines.forEach((line, index) => {
    if (line.eol !== '') {
      const entry = seen.get(line.eol) ?? { count: 0, last: 0 }
      seen.set(line.eol, { count: entry.count + 1, last: index })
    }
  })
  let best = null
  for (const [eol, entry] of seen) {
    if (
      best === null ||
      entry.count > best.count ||
      (entry.count === best.count && entry.last > best.last)
    ) {
      best = { eol, ...entry }
    }
  }
  return best === null ? null : best.eol
}

/**
 * Walks the lines once, tracking which block they are in.
 * `headings` holds H1 and H2 only: `line` is the first line of the heading
 * (the first line of the paragraph, for a setext heading).
 * @param {string} text
 */
function scanMarkdown(text) {
  const lines = splitLines(text)
  const kinds = []
  const headings = []
  let mode = 'normal'
  let fence = null
  let paragraph = -1

  lines.forEach((line, index) => {
    const content = line.text
    if (mode === 'fence') {
      kinds.push('fence')
      const closer = new RegExp(
        `^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`,
      ).test(content)
      mode = closer ? 'normal' : 'fence'
      return
    }
    if (mode === 'comment') {
      kinds.push('comment')
      mode = content.includes('-->') ? 'normal' : 'comment'
      return
    }
    if (BLANK.test(content)) {
      kinds.push('text')
      paragraph = -1
      return
    }
    if (BLOCK_QUOTE.test(content)) {
      kinds.push('quote')
      paragraph = -1
      return
    }
    if (!NOT_INDENTED.test(content)) {
      // Indented code, or a paragraph continuation: it changes no structure.
      kinds.push('text')
      return
    }
    const fenceStart = FENCE_OPEN.exec(content)
    if (
      fenceStart !== null &&
      !(fenceStart[1][0] === '`' && fenceStart[2].includes('`'))
    ) {
      kinds.push('fence')
      mode = 'fence'
      fence = { char: fenceStart[1][0], length: fenceStart[1].length }
      paragraph = -1
      return
    }
    if (COMMENT_OPEN.test(content)) {
      kinds.push('comment')
      mode = content.includes('-->') ? 'normal' : 'comment'
      paragraph = -1
      return
    }
    kinds.push('text')
    const atx = ATX_HEADING.exec(content)
    if (atx !== null) {
      paragraph = -1
      if (atx[1].length <= 2) {
        headings.push({
          line: index,
          demo: DEMO_HEADING.test(content),
          screenshots: SCREENSHOTS_HEADING.test(content),
        })
      }
      return
    }
    if (paragraph >= 0 && SETEXT_UNDERLINE.test(content)) {
      headings.push({ line: paragraph, demo: false, screenshots: false })
      paragraph = -1
      return
    }
    if (THEMATIC_BREAK.test(content) || LIST_ITEM.test(content)) {
      paragraph = -1
      return
    }
    if (paragraph < 0) {
      paragraph = index
    }
  })

  return { text, lines, kinds, headings, endState: mode }
}

/**
 * Every Demo section in the scanned text. `contentEnd` is the first line of
 * the trailing blank run, so the gap before the next section stays outside.
 * @param {ReturnType<typeof scanMarkdown>} scan
 */
function findDemoSections(scan) {
  const { lines, headings } = scan
  return headings
    .filter((heading) => heading.demo)
    .map((heading) => {
      const following = headings.find((other) => other.line > heading.line)
      const endLine = following === undefined ? lines.length : following.line
      let contentEnd = endLine
      while (
        contentEnd > heading.line + 1 &&
        BLANK.test(lines[contentEnd - 1].text)
      ) {
        contentEnd -= 1
      }
      return { headingLine: heading.line, contentEnd }
    })
}

/**
 * @param {ReturnType<typeof scanMarkdown>} scan
 * @param {number} line
 */
function offsetOfLine(scan, line) {
  return line < scan.lines.length ? scan.lines[line].start : scan.text.length
}

// ── Splice, extract ────────────────────────────────────────────────────────

/**
 * The Demo text must be exactly one Demo section: the heading on the first
 * line, no other H1 or H2, and no fence or comment left open (it would swallow
 * whatever follows it in the body). Trailing blank lines are dropped.
 * @param {string} text
 * @returns {{ ok: true, section: string, scan: ReturnType<typeof scanMarkdown> } | { ok: false }}
 */
function parseDemoText(text) {
  const scan = scanMarkdown(text)
  const [only] = scan.headings
  if (
    scan.headings.length !== 1 ||
    only.line !== 0 ||
    !only.demo ||
    scan.endState !== 'normal'
  ) {
    return { ok: false }
  }
  const [section] = findDemoSections(scan)
  return {
    ok: true,
    section: text.slice(0, offsetOfLine(scan, section.contentEnd)),
    scan,
  }
}

/** @param {string} body */
function inspectBody(body) {
  const scan = scanMarkdown(body)
  return {
    scan,
    sections: findDemoSections(scan),
    screenshots: scan.headings.some((heading) => heading.screenshots),
  }
}

/**
 * Splices the Demo section into the body: replaces the content under the one
 * existing heading (the heading line's bytes are kept), or appends the whole
 * section after exactly one blank line.
 * @param {string} body
 * @param {string} demoText
 */
export function spliceDemo(body, demoText) {
  const demo = parseDemoText(demoText)
  if (!demo.ok) {
    return { kind: 'invalid-demo' }
  }
  const { scan, sections, screenshots } = inspectBody(body)
  const base = { demoCount: sections.length, screenshots }
  if (sections.length > 1) {
    return { kind: 'multiple-demo-sections', ...base }
  }
  const eol = dominantEol(scan.lines) ?? dominantEol(demo.scan.lines) ?? '\n'

  if (sections.length === 1) {
    const [section] = sections
    const heading = scan.lines[section.headingLine]
    const content = demo.section.slice(demo.scan.lines[0].next)
    const suffix = body.slice(offsetOfLine(scan, section.contentEnd))
    const headBreak = heading.eol === '' && content.length > 0 ? eol : ''
    const tailBreak =
      suffix.length > 0 && content.length > 0 && !ENDS_WITH_BREAK.test(content)
        ? eol
        : ''
    const output = joinPieces([
      body.slice(0, heading.next),
      headBreak,
      content,
      tailBreak,
      suffix,
    ])
    if (output === null) {
      return { kind: 'line-ending-conflict', ...base }
    }
    return {
      kind: 'spliced',
      action: output === body ? 'unchanged' : 'replaced',
      output,
      ...base,
    }
  }

  if (scan.endState !== 'normal') {
    return { kind: 'unterminated-region', region: scan.endState, ...base }
  }
  const output = joinPieces([
    body,
    separatorBeforeAppend(scan.lines, eol),
    demo.section,
  ])
  if (output === null) {
    return { kind: 'line-ending-conflict', ...base }
  }
  return { kind: 'spliced', action: 'appended', output, ...base }
}

/**
 * Concatenates the pieces, or returns null when a CR would meet an LF. That
 * only happens in a body that mixes terminators, and the pair would fuse into
 * one CRLF and silently drop a line, so the helper stops instead.
 * @param {string[]} pieces
 */
function joinPieces(pieces) {
  const present = pieces.filter((piece) => piece.length > 0)
  for (let i = 1; i < present.length; i += 1) {
    if (present[i - 1].endsWith('\r') && present[i].startsWith('\n')) {
      return null
    }
  }
  return present.join('')
}

/**
 * Just enough line breaks to end the last line and leave one blank line.
 * A body with no non-blank content needs no blank line.
 * @param {Array<{ text: string, eol: string }>} lines
 * @param {string} eol
 */
function separatorBeforeAppend(lines, eol) {
  if (lines.length === 0) {
    return ''
  }
  const last = lines[lines.length - 1]
  const endsLine = last.eol === '' ? eol : ''
  if (lines.every((line) => BLANK.test(line.text))) {
    return endsLine
  }
  return BLANK.test(last.text) ? endsLine : `${endsLine}${eol}`
}

/**
 * The existing Demo section, heading through its last non-blank line.
 * @param {string} body
 */
export function extractDemo(body) {
  const { scan, sections, screenshots } = inspectBody(body)
  const base = { demoCount: sections.length, screenshots }
  if (sections.length > 1) {
    return { kind: 'multiple-demo-sections', ...base }
  }
  if (sections.length === 0) {
    return { kind: 'absent', ...base }
  }
  const [section] = sections
  return {
    kind: 'extracted',
    section: body.slice(
      offsetOfLine(scan, section.headingLine),
      offsetOfLine(scan, section.contentEnd),
    ),
    ...base,
  }
}

// ── Managed URLs ───────────────────────────────────────────────────────────

const OWNER_OR_REPO = '[A-Za-z0-9._-]+'
const SHA_SEGMENT = '[0-9a-fA-F]{40}'
// docs/evidence/<slug>/<name>, as classify writes it: a slug of at most 60
// characters over [a-z0-9-], a name over [a-z0-9._-] with no "..", and an
// extension that follows the detected image type.
const EVIDENCE_PATH =
  'docs/evidence/[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?/(?!.*\\.\\.)[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\\.(?:png|jpg|gif|webp)'
const MANAGED_PATH = new RegExp(`^${EVIDENCE_PATH}$`)
const RAW_URL = new RegExp(
  `^https://raw\\.githubusercontent\\.com/(${OWNER_OR_REPO})/(${OWNER_OR_REPO})/(${SHA_SEGMENT})/(${EVIDENCE_PATH})$`,
)
const BLOB_URL = new RegExp(
  `^https://github\\.com/(${OWNER_OR_REPO})/(${OWNER_OR_REPO})/blob/(${SHA_SEGMENT})/(${EVIDENCE_PATH})(?:\\?raw=true)?$`,
)
const URL_CANDIDATE = /https?:\/\/[^\s<>()"'`[\]]+/g
const TRAILING_PUNCTUATION = /[.,;:!?]+$/
const HEAD_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * @param {string} url
 * @param {string} headRepo
 */
function parseManagedUrl(url, headRepo) {
  const raw = RAW_URL.exec(url)
  const blob = raw === null ? BLOB_URL.exec(url) : null
  const match = raw ?? blob
  if (match === null) {
    return null
  }
  const [, owner, repo, sha, urlPath] = match
  if (`${owner}/${repo}`.toLowerCase() !== headRepo.toLowerCase()) {
    return null
  }
  const prefix =
    raw === null
      ? `https://github.com/${owner}/${repo}/blob/`
      : `https://raw.githubusercontent.com/${owner}/${repo}/`
  return {
    owner,
    repo,
    sha,
    path: urlPath,
    form: raw === null ? 'blob' : 'raw',
    shaOffset: prefix.length,
  }
}

/**
 * Every http(s) URL in lines that render, in order: managed ones with the
 * absolute offset of their ref, and a count of all the others. URLs in fenced
 * code and HTML comments are not embeds, so they count as neither.
 * @param {string} body
 * @param {string} headRepo
 */
function scanUrls(body, headRepo) {
  const scan = scanMarkdown(body)
  const managed = []
  let ignored = 0
  scan.lines.forEach((line, index) => {
    if (scan.kinds[index] === 'fence' || scan.kinds[index] === 'comment') {
      return
    }
    for (const match of line.text.matchAll(URL_CANDIDATE)) {
      const url = match[0].replace(TRAILING_PUNCTUATION, '')
      const parsed = parseManagedUrl(url, headRepo)
      if (parsed === null) {
        ignored += 1
      } else {
        const { shaOffset, ...fields } = parsed
        managed.push({
          ...fields,
          offset: line.start + match.index + shaOffset,
        })
      }
    }
  })
  return { managed, ignored }
}

/**
 * @param {string} body
 * @param {string} headRepo
 */
export function findManagedUrls(body, headRepo) {
  const { managed, ignored } = scanUrls(body, headRepo)
  return {
    urls: managed.map(({ offset, ...fields }) => fields),
    ignored,
  }
}

/**
 * Swaps the 40-hex ref of each managed URL whose path has a different pin.
 * @param {string} body
 * @param {string} headRepo
 * @param {Record<string, string>} pins
 */
export function repinBody(body, headRepo, pins) {
  const { managed, ignored } = scanUrls(body, headRepo)
  const stale = managed.filter(
    (url) => Object.hasOwn(pins, url.path) && pins[url.path] !== url.sha,
  )
  let output = body
  for (const url of [...stale].reverse()) {
    output = `${output.slice(0, url.offset)}${pins[url.path]}${output.slice(url.offset + 40)}`
  }
  return {
    output,
    rewritten: stale.length,
    ignored,
    unmappedPaths: [
      ...new Set(
        managed
          .filter((url) => !Object.hasOwn(pins, url.path))
          .map((url) => url.path),
      ),
    ].sort(),
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

/**
 * Fixed error codes only: the caller's text is never echoed back.
 * @param {string} operation
 * @param {string} error
 */
function usageError(operation, error) {
  return {
    exitCode: 2,
    body: {
      schema_version: SCHEMA_VERSION,
      operation,
      result: 'usage-error',
      error,
      usage: USAGE,
    },
  }
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value */
function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, input: Parameters<typeof classify>[0] } | { ok: false, error: string }}
 */
function parseInput(raw) {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'invalid-input' }
  }
  const { paths, branch, topic, existing, max_bytes, warn_bytes } = raw
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: 'empty-paths' }
  }
  if (
    !paths.every(
      (item) =>
        typeof item === 'string' && item.length > 0 && !item.includes('\0'),
    )
  ) {
    return { ok: false, error: 'invalid-input' }
  }
  const optionalString = (value) =>
    value === undefined || typeof value === 'string'
  if (!optionalString(branch) || !optionalString(topic)) {
    return { ok: false, error: 'invalid-input' }
  }
  if (branch === undefined && (topic === undefined || topic.length === 0)) {
    return { ok: false, error: 'missing-topic-source' }
  }
  if (
    existing !== undefined &&
    !(
      isPlainObject(existing) &&
      Object.values(existing).every((sha) => typeof sha === 'string')
    )
  ) {
    return { ok: false, error: 'invalid-input' }
  }
  for (const limit of [max_bytes, warn_bytes]) {
    if (limit !== undefined && !isPositiveInteger(limit)) {
      return { ok: false, error: 'invalid-input' }
    }
  }
  return {
    ok: true,
    input: {
      paths,
      branch,
      topic,
      existing: existing ?? {},
      maxBytes: max_bytes ?? DEFAULT_MAX_BYTES,
      warnBytes: warn_bytes ?? DEFAULT_WARN_BYTES,
    },
  }
}

/**
 * Fixed vocabulary for every subcommand but classify: `result` is one of
 * spliced, extracted, absent, urls, repinned, needs-input, write-failed or
 * usage-error, and `asks` carries the question when it is needs-input.
 * @param {string} operation
 * @param {number} exitCode
 * @param {string} result
 * @param {Record<string, unknown>} parts
 */
function outcome(operation, exitCode, result, parts = {}) {
  return {
    exitCode,
    body: { schema_version: SCHEMA_VERSION, operation, result, ...parts },
  }
}

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const MAX_DEMO_BYTES = 1024 * 1024

/** A body that survives a UTF-8 write unchanged. @param {unknown} value */
function isBody(value) {
  return typeof value === 'string' && !LONE_SURROGATE.test(value)
}

/** @param {unknown} value */
function isPathString(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

/** @param {unknown} value */
function isPins(value) {
  return (
    isPlainObject(value) &&
    Object.entries(value).every(
      ([key, sha]) =>
        MANAGED_PATH.test(key) && typeof sha === 'string' && FULL_SHA.test(sha),
    )
  )
}

/**
 * The output file is the only thing the helper ever writes. A file that
 * exists keeps its mode; a new one is created 0600.
 * @param {string} operation
 * @param {string} outFile
 * @param {string} text
 * @param {Record<string, unknown>} parts
 */
function writeBody(operation, outFile, text, parts) {
  const bytes = Buffer.from(text, 'utf8')
  try {
    writeFileSync(path.resolve(outFile), bytes, { mode: 0o600 })
  } catch {
    return outcome(operation, 1, 'write-failed', { error: 'write-failed' })
  }
  return { ...parts, out_file: outFile, bytes: bytes.length }
}

/** @param {unknown} raw */
function runClassify(raw) {
  const parsed = parseInput(raw)
  return parsed.ok
    ? classify(parsed.input)
    : usageError('classify', parsed.error)
}

/**
 * @param {string} file
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
function readDemoFile(file) {
  const candidate = readCandidate(file, MAX_DEMO_BYTES)
  if (!candidate.ok) {
    return { ok: false, error: 'demo-file-unreadable' }
  }
  try {
    // ignoreBOM keeps a BOM in the text instead of silently dropping it.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    return { ok: true, text: decoder.decode(candidate.bytes) }
  } catch {
    return { ok: false, error: 'demo-file-not-utf8' }
  }
}

/** @param {unknown} raw */
function runSplice(raw) {
  if (
    !isPlainObject(raw) ||
    !isBody(raw.body) ||
    !isPathString(raw.demo_file) ||
    !isPathString(raw.out_file)
  ) {
    return usageError('splice', 'invalid-input')
  }
  const demoFile = readDemoFile(raw.demo_file)
  if (!demoFile.ok) {
    return usageError('splice', demoFile.error)
  }
  const result = spliceDemo(raw.body, demoFile.text)
  const report = {
    demo_count: result.demoCount,
    screenshots_present: result.screenshots,
  }
  switch (result.kind) {
    case 'invalid-demo':
      return usageError('splice', 'invalid-demo')
    case 'multiple-demo-sections':
      return outcome('splice', 1, 'needs-input', {
        ...report,
        asks: [{ code: 'multiple-demo-sections', count: result.demoCount }],
      })
    case 'unterminated-region':
      return outcome('splice', 1, 'needs-input', {
        ...report,
        asks: [{ code: 'unterminated-region', kind: result.region }],
      })
    case 'line-ending-conflict':
      return outcome('splice', 1, 'needs-input', {
        ...report,
        asks: [{ code: 'line-ending-conflict' }],
      })
    default: {
      const written = writeBody('splice', raw.out_file, result.output, {
        action: result.action,
        ...report,
      })
      return 'exitCode' in written
        ? written
        : outcome('splice', 0, 'spliced', written)
    }
  }
}

/** @param {unknown} raw */
function runExtract(raw) {
  if (!isPlainObject(raw) || !isBody(raw.body) || !isPathString(raw.out_file)) {
    return usageError('extract', 'invalid-input')
  }
  const result = extractDemo(raw.body)
  const report = { demo_count: result.demoCount }
  switch (result.kind) {
    case 'multiple-demo-sections':
      return outcome('extract', 1, 'needs-input', {
        ...report,
        asks: [{ code: 'multiple-demo-sections', count: result.demoCount }],
      })
    case 'absent':
      return outcome('extract', 0, 'absent', report)
    default: {
      const written = writeBody('extract', raw.out_file, result.section, report)
      return 'exitCode' in written
        ? written
        : outcome('extract', 0, 'extracted', written)
    }
  }
}

/** @param {unknown} raw */
function runUrls(raw) {
  if (
    !isPlainObject(raw) ||
    !isBody(raw.body) ||
    typeof raw.head_repo !== 'string' ||
    !HEAD_REPO.test(raw.head_repo)
  ) {
    return usageError('urls', 'invalid-input')
  }
  return outcome('urls', 0, 'urls', findManagedUrls(raw.body, raw.head_repo))
}

/** @param {unknown} raw */
function runRepin(raw) {
  if (
    !isPlainObject(raw) ||
    !isBody(raw.body) ||
    typeof raw.head_repo !== 'string' ||
    !HEAD_REPO.test(raw.head_repo) ||
    !isPins(raw.pins) ||
    !isPathString(raw.out_file)
  ) {
    return usageError('repin-rewrite', 'invalid-input')
  }
  const result = repinBody(raw.body, raw.head_repo, raw.pins)
  const written = writeBody('repin-rewrite', raw.out_file, result.output, {
    action: result.rewritten > 0 ? 'rewritten' : 'unchanged',
    rewritten: result.rewritten,
    unmapped_paths: result.unmappedPaths,
    ignored: result.ignored,
  })
  return 'exitCode' in written
    ? written
    : outcome('repin-rewrite', 0, 'repinned', written)
}

const OPERATIONS = {
  classify: runClassify,
  splice: runSplice,
  extract: runExtract,
  urls: runUrls,
  'repin-rewrite': runRepin,
}

/** @param {string[]} argv */
function run(argv) {
  const operation = argv.length === 1 ? argv[0] : undefined
  if (operation === undefined || !Object.hasOwn(OPERATIONS, operation)) {
    return usageError('unknown', 'unknown-operation')
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return usageError(operation, 'invalid-json')
  }
  return OPERATIONS[operation](raw)
}

function main() {
  let outcome
  try {
    outcome = run(process.argv.slice(2))
  } catch {
    // One fixed object and exit 1, never a stack trace with local paths.
    outcome = {
      exitCode: 1,
      body: {
        schema_version: SCHEMA_VERSION,
        operation: 'unknown',
        result: 'internal-error',
        error: 'internal-error',
        usage: USAGE,
      },
    }
  }
  process.stdout.write(`${JSON.stringify(outcome.body)}\n`)
  process.exitCode = outcome.exitCode
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectInvocation) {
  main()
}
