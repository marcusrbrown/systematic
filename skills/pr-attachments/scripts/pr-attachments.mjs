#!/usr/bin/env node

// Helper for the pr-attachments skill: the gates that must be exact.
//
// Every subcommand reads one JSON object on stdin and writes one JSON object
// on stdout. None prints file or body contents. Each reports only the paths
// the caller gave it, except `cleanup-set`, which reports the paths git
// found under docs/evidence. A PR body is decoded once, from the JSON string.
// A body the helper produces goes to the file named by `out_file`, never to
// stdout. The one other thing the helper changes is the index, through
// `git rm` in the `cleanup-set` removal step.
//
// Usage:
//   node pr-attachments.mjs classify       < input.json
//   node pr-attachments.mjs splice         < input.json
//   node pr-attachments.mjs extract        < input.json
//   node pr-attachments.mjs urls           < input.json
//   node pr-attachments.mjs repin-rewrite  < input.json
//   node pr-attachments.mjs pins           < input.json
//   node pr-attachments.mjs cleanup-set    < input.json
//   node pr-attachments.mjs verify         < input.json
//
// classify sorts explicit image paths into accepted entries with destination
// names, or rejects the whole batch.
//   paths        non-empty array of image file paths (relative to the cwd)
//   branch       branch name, used for the topic when `topic` is empty
//   topic        optional user-supplied topic; wins over `branch`
//   existing     optional map of destination path -> git blob SHA already
//                present at that path on the head commit
//   max_bytes    optional size limit, default 10 MiB (injectable for tests).
//                GitHub serves a PNG as image/png up to exactly 10 MiB and as
//                application/octet-stream from one byte more, so a larger file
//                is rejected as `too-large` before anything is published.
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
// pins and cleanup-set run git themselves, from the top of the repository
// that holds the working directory (the skill fetches first). They never take
// git output as input. Every git call is an argv array with a timeout, no
// stdin, literal pathspecs and a sanitized environment (every GIT_* variable
// dropped but GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM). Both take an
// optional `git_timeout_ms` per call (default 10000, at most 120000).
//
// pins reports, for each managed path, whether the pins in the body still
// serve the image that is on the PR head.
//   head_ref_oid  the PR head commit (40 hex, lower case)
//   urls          non-empty array of { path, sha }; the `urls` array of the
//                 `urls` subcommand fits as it is, and other fields are ignored
//   For each path it finds the newest commit reachable from `head_ref_oid`
//   that added or modified it. A pin is valid when its commit exists, is
//   reachable from the head, and holds the same blob at the path as that
//   newest commit; reachability alone is not enough. `pins` in the report is
//   the map `repin-rewrite` takes: the newest commit for a stale path, and the
//   pin already in the body for a path whose pins are valid.
//   result  already-valid (0), repin-needed (0), partial (1: some paths never
//           existed on the head), unresolved (1: none did), head-not-found (1)
//
// cleanup-set lists the files the PR added under docs/evidence, and removes
// them in a second step.
//   head_ref_oid  the PR head commit
//   base_ref_name + remote   the base branch and the remote it was fetched
//                 from, read as refs/remotes/<remote>/<name>; or
//   base_ref      one fully qualified ref, such as refs/remotes/origin/main
//   remove_digest optional; turns the call into the removal step
//   The set is the files the PR added (rename detection off, so a rename in
//   counts as an add), less every path present at the base tip, not the
//   merge-base. It is sorted, with a digest of the set.
//   Removal recomputes the set, refuses with digest-mismatch unless its digest
//   equals `remove_digest`, refuses with head-not-checked-out unless HEAD is
//   `head_ref_oid`, and only then runs `git rm` on the set. It stages the
//   removals and commits nothing.
//   result  set (0), empty (0), removed (0), digest-mismatch (1),
//           head-not-checked-out (1), head-not-found (1), base-not-found (1),
//           no-merge-base (1)
//
// A git failure or timeout exits 1 with result git-failed or git-timeout and
// `reached`: the step it stopped at, and the progress made (paths done for
// pins, whether removal had started for cleanup-set).
//
// verify is the one subcommand that uses the network. It checks that each
// managed raw URL serves an image, retrying while GitHub's CDN catches up
// with a push. It sends a bare GET (no credentials), follows at most 5
// redirects and only to raw.githubusercontent.com or media.githubusercontent.com
// over https, reads only the status and headers, and drops the body unread.
// Nothing from a response is ever printed.
//   urls               non-empty array (at most 50) of managed raw URLs:
//                      https://raw.githubusercontent.com/<owner>/<repo>/
//                      <40-hex>/docs/evidence/<slug>/<name>, with no query or
//                      fragment. A blob URL is a usage error (`blob-url`):
//                      the skill checks those through `gh api`.
//   head_repo          optional "owner/repo"; every URL must belong to it
//   max_wait_s         optional, default 90, at most 300: the most this call
//                      spends waiting between attempts
//   waited_s           optional, default 0: the `waited_s` of the latest report
//                      for the same URLs, passed on unchanged. The schedule
//                      resumes there, and the 300 s total counts it.
//   request_timeout_s  optional, default 10, at most 300: per request
//   Retried (404, 429, 5xx, network error, timeout): wait 2, 4, 8, 15, then 30 s
//   again and again, each with +-20% jitter, and never less than a 429's
//   Retry-After. A call stops when the next wait would pass `max_wait_s` or
//   the 300 s total. Each request is cut short at the time the call has left,
//   and no attempt starts once that time is gone, so a call ends at its
//   `max_wait_s` and not one request later. (A call always makes its first
//   request, even when earlier calls used up the whole total.) Final at once: a 200 that is not image/*, 401/403, any
//   other status, a redirect off the allowed hosts, a missing Location, or a
//   6th redirect. Every URL is checked at the same time.
//   result  verified (0), failed (1)
//   Each URL is { url, status, http_status, attempts, retryable }. `status` is
//   ok, not-found, rate-limited, server-error, network-error, timeout,
//   not-an-image, forbidden, unexpected-status, bad-redirect,
//   redirect-off-host or too-many-redirects. `retryable` is true when waiting
//   longer could help and the 300 s total has room for the next wait. The
//   report has `failed` (the failing entries), top-level `retryable` (any
//   failure is retryable) and `waited_s`: the longest wait of this call plus
//   the `waited_s` it was given, rounded up. It is the running total, so the
//   caller never adds reports up.
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
// the user must answer, or an output file that cannot be written, or an embed
// that does not serve an image), 2 usage error.
// A usage error carries `error` (a fixed code) and `field` (the input field
// that failed, by its schema name; `input` for the whole object and
// `operation` for the command line). Neither ever echoes caller text.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA_VERSION = 1
// The largest file raw.githubusercontent.com serves with an image type.
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const MAX_SLUG_LENGTH = 60
const EVIDENCE_ROOT = 'docs/evidence'
const SVG_MESSAGE = 'SVG is not supported by this skill'
const USAGE =
  'node pr-attachments.mjs <classify|splice|extract|urls|repin-rewrite|pins|cleanup-set|verify> < input.json'

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
 * @param {number} maxBytes
 */
function inspectFile(source, maxBytes) {
  const candidate = readCandidate(source, maxBytes)
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
    warnings: fileWarnings(source, type, candidate.bytes),
  }
}

/**
 * @param {string} source
 * @param {string} type
 * @param {Buffer} bytes
 */
function fileWarnings(source, type, bytes) {
  const warnings = []
  const trailing = trailingBytes(type, bytes)
  if (trailing > 0) {
    warnings.push({ source, code: 'trailing-data', bytes: trailing })
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
 * }} input
 */
export function classify(input) {
  const inspected = input.paths.map((source) =>
    inspectFile(source, input.maxBytes),
  )
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

// ── Git ────────────────────────────────────────────────────────────────────
//
// `pins` and `cleanup-set` run git themselves, from the top of the repository
// that holds the working directory. Their input is the caller's own data (the
// head commit, the base branch, the managed paths); git output is never an
// input, so no SHA is ever transcribed. Every call is an argv array, never a
// shell, with a timeout, no stdin and a sanitized environment. Git output is
// parsed and never echoed: the report carries fixed codes, paths and SHAs.

const DEFAULT_GIT_TIMEOUT_MS = 10_000
const MAX_GIT_TIMEOUT_MS = 120_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024
const DIGEST_DOMAIN = 'pr-attachments/cleanup-set/v1'
// The only GIT_* variables that reach git: they isolate config, and cannot
// redirect the repository, the index or the object store.
const GIT_ENV_PASSTHROUGH = new Set([
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
])
const COMMIT_SHA = /^[0-9a-f]{40}$/

/**
 * Every other GIT_* variable is dropped, so the caller's environment cannot
 * point git at another repository, index or object store.
 */
function gitEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (!key.startsWith('GIT_') || GIT_ENV_PASSTHROUGH.has(key))
    ) {
      env[key] = value
    }
  }
  env.LC_ALL = 'C'
  env.LANG = 'C'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

/**
 * @param {'git-timeout' | 'git-failed'} kind
 * @param {number | null} status
 */
function gitFailure(kind, status) {
  return Object.assign(new Error(kind), { gitFailure: { kind, status } })
}

/** @param {unknown} error */
function failureOf(error) {
  return error instanceof Error && 'gitFailure' in error
    ? error.gitFailure
    : null
}

/**
 * Runs git and returns its stdout. Only the listed exit statuses are
 * answers; any other status, a timeout or a launch failure throws. The step
 * name is recorded first, so a failure reports where it stopped.
 * @param {{ cwd: string, timeoutMs: number, reached: { step: string } }} ctx
 * @param {string} step
 * @param {string[]} args
 * @param {number[]} okStatuses
 */
function runGit(ctx, step, args, okStatuses = [0]) {
  ctx.reached.step = step
  const result = spawnSync('git', ['--literal-pathspecs', ...args], {
    cwd: ctx.cwd,
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: ctx.timeoutMs,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  })
  if (result.error) {
    throw gitFailure(
      result.error.code === 'ETIMEDOUT' ? 'git-timeout' : 'git-failed',
      null,
    )
  }
  if (result.status === null || !okStatuses.includes(result.status)) {
    throw gitFailure('git-failed', result.status)
  }
  return { status: result.status, stdout: result.stdout }
}

/** @param {Buffer} output */
function firstLine(output) {
  return output.toString('utf8').split('\n')[0].trim()
}

/**
 * Runs from the top of the repository, so every path is root-relative no
 * matter which subdirectory the helper started in.
 * @param {Parameters<typeof runGit>[0]} ctx
 */
function locateRepo(ctx) {
  const top = firstLine(
    runGit(ctx, 'locate-repo', ['rev-parse', '--show-toplevel']).stdout,
  )
  if (top.length === 0) {
    throw gitFailure('git-failed', 0)
  }
  ctx.cwd = top
}

/**
 * The commit a revision names, or null when the repository does not have it.
 * @param {Parameters<typeof runGit>[0]} ctx
 * @param {string} step
 * @param {string} rev
 */
function resolveCommit(ctx, step, rev) {
  const result = runGit(
    ctx,
    step,
    ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`],
    [0, 1],
  )
  return result.status === 0 ? firstLine(result.stdout) : null
}

/**
 * The object id at `<commit>:<path>`, or null when the path is not there.
 * @param {Parameters<typeof runGit>[0]} ctx
 * @param {string} step
 * @param {string} spec
 */
function resolveObject(ctx, step, spec) {
  const result = runGit(
    ctx,
    step,
    ['rev-parse', '--verify', '--quiet', spec],
    [0, 1],
  )
  return result.status === 0 ? firstLine(result.stdout) : null
}

/**
 * Splits NUL-terminated output. Names that are not valid UTF-8 cannot make
 * the round trip through JSON and back to git, so they fail the run.
 * @param {Buffer} output
 */
function parseNulList(output) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(output)
  } catch {
    throw gitFailure('git-failed', 0)
  }
  return text.split('\0').filter((entry) => entry.length > 0)
}

// ── pins ───────────────────────────────────────────────────────────────────

/**
 * The newest commit reachable from the head that added or modified the path.
 * Renames count as an add, so the commit that moved a file in is the answer.
 * `-m` lets a merge that resolved the file to bytes neither parent had count
 * as a modification; topological order puts a child before its parents.
 * @param {Parameters<typeof runGit>[0]} ctx
 * @param {string} headOid
 * @param {string} file
 */
function newestCommitFor(ctx, headOid, file) {
  const result = runGit(ctx, 'newest-commit', [
    'log',
    '--topo-order',
    '-m',
    '--no-renames',
    '--diff-filter=AM',
    '--no-show-signature',
    '--format=%H',
    headOid,
    '--',
    file,
  ])
  const first = firstLine(result.stdout)
  return COMMIT_SHA.test(first) ? first : null
}

/**
 * A pin is valid when the commit exists, is reachable from the head, and holds
 * the same blob at the path as the newest add-or-modify commit. Reachability
 * alone would let a replaced image come back.
 * @param {Parameters<typeof runGit>[0]} ctx
 * @param {string} headOid
 * @param {string} file
 * @param {string} newestBlob
 * @param {string} sha
 */
function judgePin(ctx, headOid, file, newestBlob, sha) {
  if (resolveCommit(ctx, 'pin-commit', sha) === null) {
    return { sha, valid: false, reason: 'commit-unknown' }
  }
  const reachable = runGit(
    ctx,
    'pin-reachable',
    ['merge-base', '--is-ancestor', sha, headOid],
    [0, 1],
  )
  if (reachable.status !== 0) {
    return { sha, valid: false, reason: 'not-reachable' }
  }
  const blob = resolveObject(ctx, 'pin-blob', `${sha}:${file}`)
  if (blob === null) {
    return { sha, valid: false, reason: 'path-missing' }
  }
  if (blob !== newestBlob) {
    return { sha, valid: false, reason: 'blob-differs' }
  }
  return { sha, valid: true, reason: null }
}

/**
 * @param {Parameters<typeof runGit>[0]} ctx
 * @param {string} headOid
 * @param {string} file
 * @param {string[]} shas
 */
function assessPath(ctx, headOid, file, shas) {
  const newest = newestCommitFor(ctx, headOid, file)
  if (newest === null) {
    return {
      path: file,
      state: 'unresolved',
      newest_commit: null,
      current: shas.map((sha) => ({
        sha,
        valid: false,
        reason: 'no-newest-commit',
      })),
    }
  }
  const newestBlob = resolveObject(ctx, 'newest-blob', `${newest}:${file}`)
  if (newestBlob === null) {
    throw gitFailure('git-failed', 1)
  }
  const current = shas.map((sha) =>
    judgePin(ctx, headOid, file, newestBlob, sha),
  )
  return {
    path: file,
    state: current.every((pin) => pin.valid) ? 'valid' : 'stale',
    newest_commit: newest,
    current,
  }
}

/**
 * @param {Parameters<typeof runGit>[0] & { reached: { step: string, paths_done: number, paths_total: number } }} ctx
 * @param {{ headOid: string, paths: Map<string, string[]> }} input
 */
function pinsReport(ctx, input) {
  locateRepo(ctx)
  if (resolveCommit(ctx, 'resolve-head', input.headOid) === null) {
    return outcome('pins', 1, 'head-not-found')
  }
  const entries = []
  for (const file of [...input.paths.keys()].sort()) {
    entries.push(assessPath(ctx, input.headOid, file, input.paths.get(file)))
    ctx.reached.paths_done += 1
  }
  // The map repin-rewrite takes: a stale path goes to its newest commit, and a
  // path whose pins are all valid keeps the pin it has.
  const pins = {}
  for (const entry of entries) {
    if (entry.state === 'stale') {
      pins[entry.path] = entry.newest_commit
    } else if (entry.state === 'valid') {
      pins[entry.path] = entry.current[0].sha
    }
  }
  const unresolved = entries
    .filter((entry) => entry.state === 'unresolved')
    .map((entry) => entry.path)
  const parts = {
    head: input.headOid,
    paths: entries,
    pins,
    unresolved_paths: unresolved,
  }
  if (unresolved.length === entries.length) {
    return outcome('pins', 1, 'unresolved', parts)
  }
  if (unresolved.length > 0) {
    return outcome('pins', 1, 'partial', parts)
  }
  const stale = entries.some((entry) => entry.state === 'stale')
  return outcome('pins', 0, stale ? 'repin-needed' : 'already-valid', parts)
}

// ── cleanup-set ────────────────────────────────────────────────────────────

/**
 * A digest of the set that does not depend on the order the paths arrive in.
 * @param {string[]} paths
 */
export function cleanupDigest(paths) {
  const hash = createHash('sha256').update(DIGEST_DOMAIN).update('\0')
  for (const file of [...paths].sort()) {
    hash.update(file).update('\0')
  }
  return hash.digest('hex')
}

/**
 * The set: files the PR added under docs/evidence (rename detection off, so a
 * rename in counts as an add; `git diff` is the porcelain that would detect
 * renames by default, where plumbing would not), less every path the base tip
 * already has. The
 * base tip is the right subtrahend, not the merge-base: the base may have
 * gained a path since the branch point.
 * @param {Parameters<typeof runGit>[0]} ctx
 * @param {string} mergeBase
 * @param {string} baseTip
 * @param {string} headOid
 */
function computeCleanupSet(ctx, mergeBase, baseTip, headOid) {
  const added = parseNulList(
    runGit(ctx, 'diff-added', [
      'diff',
      '--no-renames',
      '--no-ext-diff',
      '--diff-filter=A',
      '--name-only',
      '-z',
      mergeBase,
      headOid,
      '--',
      `${EVIDENCE_ROOT}/`,
    ]).stdout,
  )
  const atBase = new Set(
    parseNulList(
      runGit(ctx, 'list-base', [
        'ls-tree',
        '-r',
        '-z',
        '--name-only',
        baseTip,
        '--',
        `${EVIDENCE_ROOT}/`,
      ]).stdout,
    ),
  )
  return [...new Set(added)]
    .filter((file) => file.startsWith(`${EVIDENCE_ROOT}/`) && !atBase.has(file))
    .sort()
}

/**
 * @param {Parameters<typeof runGit>[0] & { reached: { step: string, removal_attempted: boolean } }} ctx
 * @param {{ headOid: string, baseRef: string, removeDigest?: string }} input
 */
function cleanupReport(ctx, input) {
  locateRepo(ctx)
  if (resolveCommit(ctx, 'resolve-head', input.headOid) === null) {
    return outcome('cleanup-set', 1, 'head-not-found')
  }
  const baseTip = resolveCommit(ctx, 'resolve-base', input.baseRef)
  if (baseTip === null) {
    return outcome('cleanup-set', 1, 'base-not-found')
  }
  const mergeBaseRun = runGit(
    ctx,
    'merge-base',
    ['merge-base', baseTip, input.headOid],
    [0, 1],
  )
  if (mergeBaseRun.status !== 0) {
    return outcome('cleanup-set', 1, 'no-merge-base', { base_tip: baseTip })
  }
  const mergeBase = firstLine(mergeBaseRun.stdout)
  const paths = computeCleanupSet(ctx, mergeBase, baseTip, input.headOid)
  const parts = {
    head: input.headOid,
    base_tip: baseTip,
    merge_base: mergeBase,
    paths,
    count: paths.length,
    digest: cleanupDigest(paths),
  }
  if (input.removeDigest === undefined) {
    return outcome('cleanup-set', 0, paths.length > 0 ? 'set' : 'empty', parts)
  }
  // Removal: the set just computed must be the set that was approved.
  if (parts.digest !== input.removeDigest) {
    return outcome('cleanup-set', 1, 'digest-mismatch', parts)
  }
  if (paths.length === 0) {
    return outcome('cleanup-set', 0, 'empty', parts)
  }
  const checkedOut = resolveCommit(ctx, 'check-head', 'HEAD')
  if (checkedOut !== input.headOid) {
    return outcome('cleanup-set', 1, 'head-not-checked-out', parts)
  }
  ctx.reached.removal_attempted = true
  runGit(ctx, 'remove', ['rm', '-q', '--', ...paths])
  return outcome('cleanup-set', 0, 'removed', parts)
}

/**
 * Runs a git-backed operation. A git failure or timeout becomes exit 1 with
 * the step it reached; anything else is a bug and propagates.
 * @param {string} operation
 * @param {number} timeoutMs
 * @param {Record<string, unknown>} reached
 * @param {(ctx: any) => { exitCode: number, body: Record<string, unknown> }} work
 */
function withGit(operation, timeoutMs, reached, work) {
  const ctx = {
    cwd: process.cwd(),
    timeoutMs,
    reached: { step: 'start', ...reached },
  }
  try {
    return work(ctx)
  } catch (error) {
    const failure = failureOf(error)
    if (failure === null) {
      throw error
    }
    return outcome(operation, 1, failure.kind, {
      reached: { ...ctx.reached },
      git_status: failure.status,
    })
  }
}

// ── Verification ───────────────────────────────────────────────────────────
//
// The one network call in the helper, because retry timing has to be exact.
// It sends a bare GET (no credentials, redirects handled here, hop by hop),
// looks at the status and headers, and drops the body unread. The clock, the
// sleep, the timer, the random source, the fetch and the host rule are
// injected, so tests need no network and no real waiting.

const ALLOWED_HOSTS = new Set([
  'raw.githubusercontent.com',
  'media.githubusercontent.com',
])
const MAX_REDIRECTS = 5
const MAX_VERIFY_URLS = 50
const BACKOFF_MS = [2000, 4000, 8000, 15_000, 30_000]
const JITTER = 0.2
const TOTAL_BUDGET_MS = 300_000
const DEFAULT_MAX_WAIT_MS = 90_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
// A backstop for odd injected schedules; the default schedule ends by time.
const DEFAULT_MAX_ATTEMPTS = 30
const IMAGE_TYPE = /^image\/[a-z0-9][a-z0-9.+-]*$/
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])
const RETRYABLE_STATUSES = new Set([
  'not-found',
  'rate-limited',
  'server-error',
  'network-error',
  'timeout',
])
const TIMED_OUT = Symbol('timed-out')

/**
 * Where a request may go: https, one of the two GitHub content hosts, the
 * default port, no credentials in the URL.
 * @param {URL} target
 */
function isManagedTarget(target) {
  return (
    target.protocol === 'https:' &&
    ALLOWED_HOSTS.has(target.hostname) &&
    target.port === '' &&
    target.username === '' &&
    target.password === ''
  )
}

/** @param {unknown} response */
function dropBody(response) {
  try {
    // Not awaited: cancelling must never be able to hold the check up.
    Promise.resolve(response.body?.cancel()).catch(() => {})
  } catch {}
}

/**
 * Reads only the status and headers of a response.
 * @param {Response} response
 */
function judgeResponse(response) {
  const code = response.status
  const known = (status, extra = {}) => ({ status, httpStatus: code, ...extra })
  if (REDIRECT_CODES.has(code)) {
    return known('redirect', { location: response.headers.get('location') })
  }
  if (code === 200) {
    const type = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    return known(IMAGE_TYPE.test(type) ? 'ok' : 'not-an-image')
  }
  if (code === 404) {
    return known('not-found')
  }
  if (code === 429) {
    // Delta-seconds only; an HTTP date falls back to the schedule.
    const header = response.headers.get('retry-after')?.trim() ?? ''
    return known('rate-limited', {
      retryAfterMs: /^\d{1,6}$/.test(header) ? Number(header) * 1000 : 0,
    })
  }
  if (code >= 500 && code < 600) {
    return known('server-error')
  }
  if (code === 401 || code === 403) {
    return known('forbidden')
  }
  return known('unexpected-status')
}

/**
 * What `verifyUrls` builds once per call and hands to `verifyOne`, `attempt`
 * and `probe`. The function fields are the injectable seams; the rest are the
 * resolved limits and the start reading.
 * @typedef {object} VerifyContext
 * @property {(input: string, init: RequestInit) => Promise<Response>} fetch
 * @property {(ms: number) => Promise<void>} sleep
 * @property {(ms: number, fire: () => void) => () => void} startTimer Returns the function that cancels the timer.
 * @property {() => number} random A value in [0, 1).
 * @property {(target: URL) => boolean} isAllowedTarget
 * @property {number} requestTimeoutMs
 * @property {number} maxAttempts
 * @property {number} callLimitMs The most this call may spend waiting.
 * @property {readonly number[]} scheduleMs
 * @property {number} waitedMs Time earlier calls already waited.
 * @property {number} totalBudgetMs
 * @property {number} firstStep Where in `scheduleMs` the first wait falls.
 * @property {() => number} now
 * @property {number} start The `now()` reading when the call began.
 */

/**
 * One request, bounded by `timeoutMs`. The body is cancelled whatever the
 * status was, and a stalled request is aborted.
 * @param {string} url
 * @param {VerifyContext} ctx
 * @param {number} timeoutMs
 */
async function probe(url, ctx, timeoutMs) {
  const controller = new AbortController()
  let cancelTimer = () => {}
  const timedOut = new Promise((resolve) => {
    cancelTimer = ctx.startTimer(timeoutMs, () => resolve(TIMED_OUT))
  })
  const pending = Promise.resolve().then(() =>
    ctx.fetch(url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: { accept: 'image/*' },
      signal: controller.signal,
    }),
  )
  try {
    const winner = await Promise.race([pending, timedOut])
    if (winner === TIMED_OUT) {
      controller.abort()
      pending.then(dropBody, () => {})
      return { status: 'timeout', httpStatus: null }
    }
    try {
      return judgeResponse(winner)
    } finally {
      dropBody(winner)
    }
  } catch {
    controller.abort()
    return { status: 'network-error', httpStatus: null }
  } finally {
    cancelTimer()
  }
}

/** The time this call may still spend, in ms. @param {VerifyContext} ctx */
function timeLeft(ctx) {
  return ctx.callLimitMs - (ctx.now() - ctx.start)
}

/**
 * One attempt: the request plus the redirects it leads to, each hop checked
 * against the host rule before anything is sent to it. Each request is cut
 * short at the time the call has left, so a call never runs past its limit by
 * more than the clock's own slack. The first request of a call's first
 * attempt is always made, with the full request timeout when no time is left.
 * @param {string} startUrl
 * @param {VerifyContext} ctx
 * @param {boolean} first Whether this is the first attempt of the call.
 */
async function attempt(startUrl, ctx, first) {
  let current = startUrl
  for (let hops = 0; ; hops += 1) {
    const left = timeLeft(ctx)
    if (left <= 0 && !(first && hops === 0)) {
      return { status: 'timeout', httpStatus: null }
    }
    const seen = await probe(
      current,
      ctx,
      left > 0 ? Math.min(ctx.requestTimeoutMs, left) : ctx.requestTimeoutMs,
    )
    if (seen.status !== 'redirect') {
      return seen
    }
    const { httpStatus } = seen
    if (hops === MAX_REDIRECTS) {
      return { status: 'too-many-redirects', httpStatus }
    }
    let next = null
    try {
      next = seen.location ? new URL(seen.location, current) : null
    } catch {}
    if (next === null) {
      return { status: 'bad-redirect', httpStatus }
    }
    if (!ctx.isAllowedTarget(next)) {
      return { status: 'redirect-off-host', httpStatus }
    }
    current = next.href
  }
}

/**
 * Where in the schedule to start, given the seconds earlier calls already
 * waited: the delays that fit in that time are behind us.
 * @param {readonly number[]} schedule
 * @param {number} waitedMs
 */
function scheduleStart(schedule, waitedMs) {
  let index = 0
  let spent = 0
  while (index < 1000 && spent + delayAt(schedule, index) <= waitedMs) {
    spent += delayAt(schedule, index)
    index += 1
  }
  return index
}

/**
 * @param {readonly number[]} schedule
 * @param {number} index
 */
function delayAt(schedule, index) {
  return schedule[Math.min(index, schedule.length - 1)] ?? 0
}

/**
 * @param {string} url
 * @param {{ status: string, httpStatus: number | null, retryAfterMs?: number }} seen
 * @param {number} attempts
 * @param {boolean} budgetLeft
 */
function verdict(url, seen, attempts, budgetLeft) {
  return {
    url,
    status: seen.status,
    http_status: seen.httpStatus,
    attempts,
    retryable: RETRYABLE_STATUSES.has(seen.status) && budgetLeft,
  }
}

/**
 * Retries 404, 429 (never sooner than Retry-After), 5xx, network errors and
 * timeouts. Everything else, a 200 that is not an image included, is final.
 * `retryable` on a failure means that waiting longer could still help and the
 * 300 s total has room for the next wait.
 * @param {string} url
 * @param {VerifyContext} ctx
 */
async function verifyOne(url, ctx) {
  let attempts = 0
  let step = ctx.firstStep
  for (;;) {
    attempts += 1
    const seen = await attempt(url, ctx, attempts === 1)
    if (seen.status === 'ok' || !RETRYABLE_STATUSES.has(seen.status)) {
      return verdict(url, seen, attempts, false)
    }
    const spread = 1 + (ctx.random() * 2 - 1) * JITTER
    const delay = Math.max(
      Math.round(delayAt(ctx.scheduleMs, step) * spread),
      seen.retryAfterMs ?? 0,
    )
    const elapsed = ctx.now() - ctx.start
    if (attempts >= ctx.maxAttempts || elapsed + delay > ctx.callLimitMs) {
      const budgetLeft = ctx.waitedMs + elapsed + delay <= ctx.totalBudgetMs
      return verdict(url, seen, attempts, budgetLeft)
    }
    await ctx.sleep(delay)
    step += 1
    if (timeLeft(ctx) <= 0) {
      // The wait used the last of the call's time: end here, with no attempt.
      const spent = ctx.waitedMs + (ctx.now() - ctx.start)
      const budgetLeft =
        spent + delayAt(ctx.scheduleMs, step) <= ctx.totalBudgetMs
      return verdict(url, seen, attempts, budgetLeft)
    }
  }
}

/**
 * Checks each URL, all at once. The time taken is the longest one's, and the
 * result lists every URL in the order given, duplicates dropped.
 * @param {readonly string[]} urls
 * @param {Record<string, any>} [options]
 */
export async function verifyUrls(urls, options = {}) {
  const scheduleMs = options.scheduleMs ?? BACKOFF_MS
  const waitedMs = options.waitedMs ?? 0
  const totalBudgetMs = options.totalBudgetMs ?? TOTAL_BUDGET_MS
  const now = options.now ?? (() => performance.now())
  const ctx = {
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    sleep:
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    startTimer:
      options.startTimer ??
      ((ms, fire) => {
        const timer = setTimeout(fire, ms)
        return () => clearTimeout(timer)
      }),
    random: options.random ?? Math.random,
    isAllowedTarget: options.isAllowedTarget ?? isManagedTarget,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    callLimitMs: Math.min(
      options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      totalBudgetMs - waitedMs,
    ),
    scheduleMs,
    waitedMs,
    totalBudgetMs,
    firstStep: scheduleStart(scheduleMs, waitedMs),
    now,
    start: now(),
  }
  const results = await Promise.all(
    [...new Set(urls)].map((url) => verifyOne(url, ctx)),
  )
  return { results, waitedMs: now() - ctx.start }
}

// ── CLI ────────────────────────────────────────────────────────────────────

/**
 * Fixed error codes only: the caller's text is never echoed back. `field`
 * names the input field that failed, always one of the schema's own names
 * (or `input` for the whole object and `operation` for the command line), so
 * the caller can fix that one field and retry.
 * @param {string} operation
 * @param {string} error
 * @param {string} field
 */
function usageError(operation, error, field) {
  return {
    exitCode: 2,
    body: {
      schema_version: SCHEMA_VERSION,
      operation,
      result: 'usage-error',
      error,
      field,
      usage: USAGE,
    },
  }
}

/**
 * A parse failure: the fixed error code and the schema field behind it.
 * @param {string} error
 * @param {string} field
 */
function invalid(error, field) {
  return { ok: false, error, field }
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
 * @returns {{ ok: true, input: Parameters<typeof classify>[0] } | { ok: false, error: string, field: string }}
 */
function parseInput(raw) {
  if (!isPlainObject(raw)) {
    return invalid('invalid-input', 'input')
  }
  const { paths, branch, topic, existing, max_bytes } = raw
  if (!Array.isArray(paths) || paths.length === 0) {
    return invalid('empty-paths', 'paths')
  }
  if (
    !paths.every(
      (item) =>
        typeof item === 'string' && item.length > 0 && !item.includes('\0'),
    )
  ) {
    return invalid('invalid-input', 'paths')
  }
  const optionalString = (value) =>
    value === undefined || typeof value === 'string'
  if (!optionalString(branch)) {
    return invalid('invalid-input', 'branch')
  }
  if (!optionalString(topic)) {
    return invalid('invalid-input', 'topic')
  }
  if (branch === undefined && (topic === undefined || topic.length === 0)) {
    return invalid('missing-topic-source', 'branch')
  }
  if (
    existing !== undefined &&
    !(
      isPlainObject(existing) &&
      Object.values(existing).every((sha) => typeof sha === 'string')
    )
  ) {
    return invalid('invalid-input', 'existing')
  }
  if (max_bytes !== undefined && !isPositiveInteger(max_bytes)) {
    return invalid('invalid-input', 'max_bytes')
  }
  return {
    ok: true,
    input: {
      paths,
      branch,
      topic,
      existing: existing ?? {},
      maxBytes: max_bytes ?? DEFAULT_MAX_BYTES,
    },
  }
}

/**
 * Fixed vocabulary for every subcommand but classify: `result` is one of
 * spliced, extracted, absent, urls, repinned, needs-input, write-failed,
 * usage-error, already-valid, repin-needed, partial, unresolved, set, empty,
 * removed, digest-mismatch, head-not-found, base-not-found, no-merge-base,
 * head-not-checked-out, git-failed, git-timeout, verified or failed, and
 * `asks` carries the
 * question when it is needs-input.
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

/** @param {unknown} value */
function isHeadRepo(value) {
  return typeof value === 'string' && HEAD_REPO.test(value)
}

/**
 * The first required field that is missing or malformed, by schema name, or
 * null. The whole input failing is reported as the field `input`.
 * @param {unknown} raw
 * @param {ReadonlyArray<readonly [string, (value: unknown) => boolean]>} checks
 */
function firstInvalid(raw, checks) {
  if (!isPlainObject(raw)) {
    return invalid('invalid-input', 'input')
  }
  for (const [field, isValid] of checks) {
    if (!isValid(raw[field])) {
      return invalid('invalid-input', field)
    }
  }
  return null
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
    : usageError('classify', parsed.error, parsed.field)
}

/**
 * @param {string} file
 * @returns {{ ok: true, text: string } | { ok: false, error: string, field: string }}
 */
function readDemoFile(file) {
  const candidate = readCandidate(file, MAX_DEMO_BYTES)
  if (!candidate.ok) {
    return invalid('demo-file-unreadable', 'demo_file')
  }
  try {
    // ignoreBOM keeps a BOM in the text instead of silently dropping it.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    return { ok: true, text: decoder.decode(candidate.bytes) }
  } catch {
    return invalid('demo-file-not-utf8', 'demo_file')
  }
}

/** @param {unknown} raw */
function runSplice(raw) {
  const failed = firstInvalid(raw, [
    ['body', isBody],
    ['demo_file', isPathString],
    ['out_file', isPathString],
  ])
  if (failed !== null) {
    return usageError('splice', failed.error, failed.field)
  }
  const demoFile = readDemoFile(raw.demo_file)
  if (!demoFile.ok) {
    return usageError('splice', demoFile.error, demoFile.field)
  }
  const result = spliceDemo(raw.body, demoFile.text)
  const report = {
    demo_count: result.demoCount,
    screenshots_present: result.screenshots,
  }
  switch (result.kind) {
    case 'invalid-demo':
      return usageError('splice', 'invalid-demo', 'demo_file')
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
  const failed = firstInvalid(raw, [
    ['body', isBody],
    ['out_file', isPathString],
  ])
  if (failed !== null) {
    return usageError('extract', failed.error, failed.field)
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
  const failed = firstInvalid(raw, [
    ['body', isBody],
    ['head_repo', isHeadRepo],
  ])
  if (failed !== null) {
    return usageError('urls', failed.error, failed.field)
  }
  return outcome('urls', 0, 'urls', findManagedUrls(raw.body, raw.head_repo))
}

/** @param {unknown} raw */
function runRepin(raw) {
  const failed = firstInvalid(raw, [
    ['body', isBody],
    ['head_repo', isHeadRepo],
    ['pins', isPins],
    ['out_file', isPathString],
  ])
  if (failed !== null) {
    return usageError('repin-rewrite', failed.error, failed.field)
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

const REF_NAME_START = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/
const REMOTE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const DIGEST = /^[0-9a-f]{64}$/

/**
 * A conservative subset of git's ref-name rules. It cannot start with a dash,
 * so a name can never be read as an option.
 * @param {unknown} value
 */
function isRefName(value) {
  return (
    typeof value === 'string' &&
    REF_NAME_START.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.includes('/.') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock')
  )
}

/** @param {unknown} value */
function isGitTimeout(value) {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && value > 0 && value <= MAX_GIT_TIMEOUT_MS)
  )
}

/**
 * `urls` is the array the `urls` subcommand reports; extra fields are
 * ignored. Embeds of one path are grouped, with each pin lower-cased.
 * @param {unknown} raw
 */
function parsePinsInput(raw) {
  if (!isPlainObject(raw)) {
    return invalid('invalid-input', 'input')
  }
  if (
    typeof raw.head_ref_oid !== 'string' ||
    !COMMIT_SHA.test(raw.head_ref_oid)
  ) {
    return invalid('invalid-input', 'head_ref_oid')
  }
  if (!Array.isArray(raw.urls)) {
    return invalid('invalid-input', 'urls')
  }
  if (!isGitTimeout(raw.git_timeout_ms)) {
    return invalid('invalid-input', 'git_timeout_ms')
  }
  if (raw.urls.length === 0) {
    return invalid('empty-paths', 'urls')
  }
  const paths = new Map()
  for (const item of raw.urls) {
    if (
      !isPlainObject(item) ||
      typeof item.path !== 'string' ||
      !MANAGED_PATH.test(item.path) ||
      typeof item.sha !== 'string' ||
      !/^[0-9a-fA-F]{40}$/.test(item.sha)
    ) {
      return invalid('invalid-input', 'urls')
    }
    const sha = item.sha.toLowerCase()
    const shas = paths.get(item.path) ?? []
    if (!shas.includes(sha)) {
      shas.push(sha)
    }
    paths.set(item.path, shas)
  }
  return {
    ok: true,
    input: {
      headOid: raw.head_ref_oid,
      paths,
      timeoutMs: raw.git_timeout_ms ?? DEFAULT_GIT_TIMEOUT_MS,
    },
  }
}

/**
 * The base is either `base_ref_name` with the `remote` it was fetched from
 * (read as refs/remotes/<remote>/<name>), or one fully qualified `base_ref`.
 * @param {unknown} raw
 */
function parseCleanupInput(raw) {
  if (!isPlainObject(raw)) {
    return invalid('invalid-input', 'input')
  }
  if (
    typeof raw.head_ref_oid !== 'string' ||
    !COMMIT_SHA.test(raw.head_ref_oid)
  ) {
    return invalid('invalid-input', 'head_ref_oid')
  }
  if (!isGitTimeout(raw.git_timeout_ms)) {
    return invalid('invalid-input', 'git_timeout_ms')
  }
  if (
    raw.remove_digest !== undefined &&
    !(typeof raw.remove_digest === 'string' && DIGEST.test(raw.remove_digest))
  ) {
    return invalid('invalid-input', 'remove_digest')
  }
  const named = raw.base_ref_name !== undefined || raw.remote !== undefined
  let baseRef
  if (named && raw.base_ref === undefined) {
    if (!isRefName(raw.base_ref_name)) {
      return invalid('invalid-input', 'base_ref_name')
    }
    if (typeof raw.remote !== 'string' || !REMOTE_NAME.test(raw.remote)) {
      return invalid('invalid-input', 'remote')
    }
    baseRef = `refs/remotes/${raw.remote}/${raw.base_ref_name}`
  } else if (
    !named &&
    isRefName(raw.base_ref) &&
    raw.base_ref.startsWith('refs/')
  ) {
    baseRef = raw.base_ref
  } else {
    // Naming both forms, or neither, or a base_ref that is not fully qualified.
    return invalid('invalid-input', 'base_ref')
  }
  return {
    ok: true,
    input: {
      headOid: raw.head_ref_oid,
      baseRef,
      removeDigest: raw.remove_digest,
      timeoutMs: raw.git_timeout_ms ?? DEFAULT_GIT_TIMEOUT_MS,
    },
  }
}

/** @param {unknown} raw */
function runPins(raw) {
  const parsed = parsePinsInput(raw)
  if (!parsed.ok) {
    return usageError('pins', parsed.error, parsed.field)
  }
  const { input } = parsed
  return withGit(
    'pins',
    input.timeoutMs,
    { paths_done: 0, paths_total: input.paths.size },
    (ctx) => pinsReport(ctx, input),
  )
}

/** @param {unknown} raw */
function runCleanup(raw) {
  const parsed = parseCleanupInput(raw)
  if (!parsed.ok) {
    return usageError('cleanup-set', parsed.error, parsed.field)
  }
  const { input } = parsed
  return withGit(
    'cleanup-set',
    input.timeoutMs,
    { removal_attempted: false },
    (ctx) => cleanupReport(ctx, input),
  )
}

const MAX_CALL_WAIT_S = TOTAL_BUDGET_MS / 1000

/**
 * @param {unknown} value
 * @param {number} max
 */
function isSeconds(value, max) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= max
  )
}

/**
 * Only managed raw URLs are checked: the raw host, a commit ref and a
 * docs/evidence path, nothing else in the URL. A blob URL has its own code,
 * because the skill routes those to the authenticated `gh api` check.
 * @param {unknown} raw
 */
function parseVerifyInput(raw) {
  if (!isPlainObject(raw)) {
    return invalid('invalid-input', 'input')
  }
  if (!Array.isArray(raw.urls)) {
    return invalid('invalid-input', 'urls')
  }
  if (
    raw.max_wait_s !== undefined &&
    !isSeconds(raw.max_wait_s, MAX_CALL_WAIT_S)
  ) {
    return invalid('invalid-input', 'max_wait_s')
  }
  if (
    raw.request_timeout_s !== undefined &&
    !isSeconds(raw.request_timeout_s, MAX_CALL_WAIT_S)
  ) {
    return invalid('invalid-input', 'request_timeout_s')
  }
  if (
    raw.waited_s !== undefined &&
    !(
      typeof raw.waited_s === 'number' &&
      Number.isFinite(raw.waited_s) &&
      raw.waited_s >= 0
    )
  ) {
    return invalid('invalid-input', 'waited_s')
  }
  if (raw.head_repo !== undefined && !isHeadRepo(raw.head_repo)) {
    return invalid('invalid-input', 'head_repo')
  }
  if (raw.urls.length === 0) {
    return invalid('empty-urls', 'urls')
  }
  if (raw.urls.length > MAX_VERIFY_URLS) {
    return invalid('too-many-urls', 'urls')
  }
  for (const url of raw.urls) {
    if (typeof url !== 'string') {
      return invalid('invalid-url', 'urls')
    }
    if (BLOB_URL.test(url)) {
      return invalid('blob-url', 'urls')
    }
    const managed = RAW_URL.test(url)
    if (
      !managed ||
      (raw.head_repo !== undefined &&
        parseManagedUrl(url, raw.head_repo) === null)
    ) {
      return invalid('invalid-url', 'urls')
    }
  }
  return {
    ok: true,
    input: {
      urls: raw.urls,
      maxWaitS: raw.max_wait_s,
      requestTimeoutS: raw.request_timeout_s,
      waitedS: raw.waited_s,
    },
  }
}

/**
 * `verify` reports every URL as { url, status, http_status, attempts,
 * retryable }. `status` is ok, or the reason it failed: not-found,
 * rate-limited, server-error, network-error, timeout (all retried),
 * not-an-image, forbidden, unexpected-status, bad-redirect,
 * redirect-off-host or too-many-redirects (all final).
 * @param {unknown} raw
 * @param {Record<string, any>} [options]
 */
export async function runVerify(raw, options = {}) {
  const parsed = parseVerifyInput(raw)
  if (!parsed.ok) {
    return usageError('verify', parsed.error, parsed.field)
  }
  const { input } = parsed
  const { results, waitedMs } = await verifyUrls(input.urls, {
    ...options,
    ...(input.maxWaitS === undefined
      ? {}
      : { maxWaitMs: input.maxWaitS * 1000 }),
    ...(input.requestTimeoutS === undefined
      ? {}
      : { requestTimeoutMs: input.requestTimeoutS * 1000 }),
    ...(input.waitedS === undefined ? {} : { waitedMs: input.waitedS * 1000 }),
  })
  const failed = results.filter((entry) => entry.status !== 'ok')
  return outcome(
    'verify',
    failed.length === 0 ? 0 : 1,
    failed.length === 0 ? 'verified' : 'failed',
    {
      checked: results.length,
      passed: results.length - failed.length,
      // Cumulative: the waited_s that came in, plus this call's own time. A
      // caller passes the latest report's value on unchanged.
      waited_s: Math.ceil(((input.waitedS ?? 0) * 1000 + waitedMs) / 1000),
      retryable: failed.some((entry) => entry.retryable),
      results,
      failed,
    },
  )
}

const OPERATIONS = {
  classify: runClassify,
  splice: runSplice,
  extract: runExtract,
  urls: runUrls,
  'repin-rewrite': runRepin,
  pins: runPins,
  'cleanup-set': runCleanup,
  verify: runVerify,
}

/** @param {string[]} argv */
async function run(argv) {
  const operation = argv.length === 1 ? argv[0] : undefined
  if (operation === undefined || !Object.hasOwn(OPERATIONS, operation)) {
    return usageError('unknown', 'unknown-operation', 'operation')
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return usageError(operation, 'invalid-json', 'input')
  }
  return OPERATIONS[operation](raw)
}

async function main() {
  let outcome
  try {
    outcome = await run(process.argv.slice(2))
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

// Node reports import.meta.url as a real path, but argv[1] is the path as
// typed. Compare real paths so a symlinked skill directory or helper file
// still counts as a direct run.
const isDirectInvocation =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectInvocation) {
  await main()
}
