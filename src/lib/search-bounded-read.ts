/**
 * The one bounded file read behind every search reader that opens a file whose
 * content an untrusted checkout or folder controls: the project config, the
 * project identity files and the corpus and external source files.
 *
 * Import rule: node builtins only. The `systematic-search` bin bundles it, so
 * it must never import `config.ts`, `config-schema.ts` or any module that does.
 */

import fs from 'node:fs'

const READ_CHUNK_BYTES = 64 * 1024

export type BoundedRead =
  | { readonly kind: 'bytes'; readonly bytes: Buffer }
  /** The path does not exist (`ENOENT`). */
  | { readonly kind: 'absent' }
  /** The opened descriptor is not a regular file, such as a directory or a FIFO. */
  | { readonly kind: 'not-regular' }
  /** The content reached `maxBytes + 1`; `bytesRead` is what was actually read. */
  | { readonly kind: 'too-large'; readonly bytesRead: number }
  /** Any other open or read failure. */
  | { readonly kind: 'failed' }

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}

/**
 * Read a file through an open fd, never more than `maxBytes + 1` bytes.
 * Reaching `maxBytes + 1` rejects the file, so a file that is already too
 * large and one that grows past the cap while it is being read fail the same
 * way, and the size is never trusted from a `stat`. The open is non-blocking
 * and the fd must be a regular file, so a FIFO or device planted at the path
 * cannot hang the reader. Never throws.
 */
export function readBytesBounded(
  filePath: string,
  maxBytes: number,
): BoundedRead {
  let fd: number
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
    )
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'failed' }
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { kind: 'not-regular' }
    const limit = maxBytes + 1
    const chunks: Buffer[] = []
    let total = 0
    while (total < limit) {
      const chunk = Buffer.allocUnsafe(
        Math.min(READ_CHUNK_BYTES, limit - total),
      )
      const count = fs.readSync(fd, chunk, 0, chunk.length, null)
      if (count === 0) break
      chunks.push(chunk.subarray(0, count))
      total += count
    }
    if (total >= limit) return { kind: 'too-large', bytesRead: total }
    return { kind: 'bytes', bytes: Buffer.concat(chunks) }
  } catch {
    return { kind: 'failed' }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // Nothing useful to do: the read result is already decided.
    }
  }
}
