#!/usr/bin/env node

// Helper for the pr-attachments skill: the gates that must be exact.
//
// `classify` sorts explicit image paths into accepted entries with
// destination names, or rejects the whole batch. It reads one JSON object
// on stdin and writes one JSON object on stdout. It never prints file
// contents, and it only ever reports the paths the caller gave it.
//
// Usage:
//   node pr-attachments.mjs classify < input.json
//
// Input:
//   paths        non-empty array of image file paths (relative to the cwd)
//   branch       branch name, used for the topic when `topic` is empty
//   topic        optional user-supplied topic; wins over `branch`
//   existing     optional map of destination path -> git blob SHA already
//                present at that path on the head commit
//   max_bytes    optional size limit, default 100 MiB (injectable for tests)
//   warn_bytes   optional soft size, default 10 MiB (injectable for tests)
//
// Exit codes: 0 success, 1 domain failure (rejected batch, or a question
// the user must answer), 2 usage error.

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SCHEMA_VERSION = 1
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
const DEFAULT_WARN_BYTES = 10 * 1024 * 1024
const MAX_SLUG_LENGTH = 60
const EVIDENCE_ROOT = 'docs/evidence'
const SVG_MESSAGE = 'SVG is not supported by this skill'
const USAGE = 'node pr-attachments.mjs classify < input.json'

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

/** @param {string[]} argv */
function run(argv) {
  if (argv[0] !== 'classify' || argv.length !== 1) {
    return usageError('unknown', 'unknown-operation')
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return usageError('classify', 'invalid-json')
  }
  const parsed = parseInput(raw)
  return parsed.ok
    ? classify(parsed.input)
    : usageError('classify', parsed.error)
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
