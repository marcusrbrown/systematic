import fs from 'node:fs'
import { formatReviewArtifactIssuePath } from './review-artifact-path.js'
import { SubAgentReturnSchema } from './review-artifact-schema.js'

/**
 * Bounded, no-write structural validator for a single raw `ce:review` persona
 * return read from stdin.
 *
 * The runner is deliberately synchronous to match `runLegacyCli`'s shape and to
 * avoid a temp-file or async stdin dance. Behavior is injectable (argv, fd,
 * TTY, chunk reader, sinks) so tests can exercise real code paths without
 * mutating global state.
 */

export const VALIDATE_REVIEW_RETURN_USAGE =
  'Usage: systematic validate-review-return'

/** Input cap in bytes. Reads stop at {@link MAX_REVIEW_RETURN_BYTES} plus one. */
export const MAX_REVIEW_RETURN_BYTES = 1024 * 1024

/** Maximum number of projected issue lines emitted before the summary. */
export const MAX_PROJECTED_ISSUE_LINES = 8

export const REVIEW_RETURN_VALID_MESSAGE = 'Review return is valid'
export const REVIEW_RETURN_EMPTY_MESSAGE = 'Review return is empty'
export const REVIEW_RETURN_INVALID_UTF8_MESSAGE =
  'Review return is not valid UTF-8'
export const REVIEW_RETURN_MALFORMED_JSON_MESSAGE =
  'Review return is not valid JSON'
export const REVIEW_RETURN_OVERSIZED_MESSAGE =
  'Review return exceeds the 1 MiB input limit'
export const REVIEW_RETURN_READ_FAILED_MESSAGE =
  'Review return could not be read from stdin'
export const REVIEW_RETURN_TTY_MESSAGE =
  'validate-review-return reads one JSON document from stdin; interactive input is not supported'

/** One bounded, payload-safe projected validation issue. */
export interface ReviewReturnIssue {
  readonly path: string
  readonly code: string
}

export type ReviewReturnValidation =
  | { readonly ok: true }
  | {
      readonly ok: false
      /** Full issue count, even when {@link ReviewReturnValidation.issues} is capped. */
      readonly total: number
      readonly issues: readonly ReviewReturnIssue[]
    }

/**
 * Pure value-validation seam. Projects only safe Zod path segments and issue
 * codes; never issue messages, unrecognized key names, or payload values.
 */
export function validateReviewReturnValue(
  value: unknown,
): ReviewReturnValidation {
  const result = SubAgentReturnSchema.safeParse(value)
  if (result.success) return { ok: true }

  const total = result.error.issues.length
  const issues = result.error.issues
    .slice(0, MAX_PROJECTED_ISSUE_LINES)
    .map((issue) => ({
      path: formatReviewArtifactIssuePath(issue.path),
      code: issue.code,
    }))

  return { issues, ok: false, total }
}

export function formatReviewReturnValidationFailure(total: number): string {
  return `Review return validation failed: ${total} issue(s)`
}

export type ReadChunk = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
) => number

export interface ReviewReturnValidatorOptions {
  readonly argv: readonly string[]
  readonly fd?: number
  readonly isTTY?: boolean
  readonly readChunk?: ReadChunk
  readonly outputSink?: (message: string) => void
  readonly errorSink?: (message: string) => void
}

const READ_CHUNK_BYTES = 64 * 1024

type StdinRead =
  | { readonly status: 'ok'; readonly buffer: Buffer }
  | { readonly status: 'oversized' }
  | { readonly status: 'read-error' }

function defaultReadChunk(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
): number {
  return fs.readSync(fd, buffer, offset, length, position)
}

/**
 * Backoff between retries of a transient stdin read.
 *
 * Node puts a pipe-backed fd 0 into nonblocking mode as soon as its stdin
 * stream is materialized, so a producer that pauses between chunks makes
 * `fs.readSync` raise `EAGAIN`/`EWOULDBLOCK` even though the pipe is still open
 * and more data is coming. Those codes mean "nothing yet", not "read failed".
 * There is deliberately no total timeout: a slow writer must be allowed to
 * finish, matching blocking `read(2)` semantics.
 */
const TRANSIENT_READ_RETRY_MS = 1

function isTransientReadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { readonly code?: unknown }).code
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

/** Block the current thread without busy-spinning (portable Node/Bun sleep). */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/**
 * Read stdin in bounded chunks, stopping at the cap plus one byte so an
 * oversized payload is rejected without buffering the whole document.
 */
function readBoundedStdin(fd: number, readChunk: ReadChunk): StdinRead {
  const chunks: Buffer[] = []
  let total = 0

  while (true) {
    const remaining = MAX_REVIEW_RETURN_BYTES + 1 - total
    if (remaining <= 0) return { status: 'oversized' }

    const toRead = Math.min(READ_CHUNK_BYTES, remaining)
    const buffer = Buffer.allocUnsafe(toRead)

    let bytesRead: number
    try {
      bytesRead = readChunk(fd, buffer, 0, toRead, null)
    } catch (error) {
      if (isTransientReadError(error)) {
        // A nonblocking pipe with no data yet: wait briefly and retry rather
        // than reporting a permanent stdin failure.
        sleepSync(TRANSIENT_READ_RETRY_MS)
        continue
      }
      return { status: 'read-error' }
    }

    if (bytesRead <= 0) break

    total += bytesRead
    chunks.push(buffer.subarray(0, bytesRead))
    if (total > MAX_REVIEW_RETURN_BYTES) return { status: 'oversized' }
  }

  return { buffer: Buffer.concat(chunks, total), status: 'ok' }
}

function isValidInvocation(argv: readonly string[]): boolean {
  const commandIndex = argv[0] === 'systematic' ? 1 : 0
  return (
    argv[commandIndex] === 'validate-review-return' &&
    argv.length === commandIndex + 1
  )
}

/**
 * Validate exactly one raw persona return from stdin.
 *
 * Exit statuses:
 * - 0: a schema-valid `SubAgentReturnSchema` document.
 * - 1: the returned input was empty, oversized, invalid UTF-8, malformed JSON,
 *   carried trailing data, or failed the schema.
 * - 2: the check did not run (usage, TTY, or stdin read failure).
 */
export function runReviewReturnValidator(
  options: ReviewReturnValidatorOptions,
): number {
  const outputSink =
    options.outputSink ?? ((message: string) => console.log(message))
  const errorSink =
    options.errorSink ?? ((message: string) => console.error(message))
  const fd = options.fd ?? 0
  const isTTY = options.isTTY ?? (fd === 0 && process.stdin.isTTY === true)

  if (!isValidInvocation(options.argv)) {
    errorSink(VALIDATE_REVIEW_RETURN_USAGE)
    return 2
  }

  if (isTTY) {
    errorSink(REVIEW_RETURN_TTY_MESSAGE)
    return 2
  }

  const read = readBoundedStdin(fd, options.readChunk ?? defaultReadChunk)
  if (read.status === 'read-error') {
    errorSink(REVIEW_RETURN_READ_FAILED_MESSAGE)
    return 2
  }
  if (read.status === 'oversized') {
    errorSink(REVIEW_RETURN_OVERSIZED_MESSAGE)
    return 1
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.buffer)
  } catch {
    errorSink(REVIEW_RETURN_INVALID_UTF8_MESSAGE)
    return 1
  }

  if (text.trim() === '') {
    errorSink(REVIEW_RETURN_EMPTY_MESSAGE)
    return 1
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    errorSink(REVIEW_RETURN_MALFORMED_JSON_MESSAGE)
    return 1
  }

  const validation = validateReviewReturnValue(value)
  if (validation.ok) {
    outputSink(REVIEW_RETURN_VALID_MESSAGE)
    return 0
  }

  for (const issue of validation.issues) {
    errorSink(`${issue.path} ${issue.code}`)
  }
  errorSink(formatReviewReturnValidationFailure(validation.total))
  return 1
}
