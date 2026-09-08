import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { validateNpmTarball } from '../../scripts/run-evals.ts'

/**
 * Regression pin for the `noUncheckedIndexedAccess` narrowing applied to the
 * npm tarball header parser in `scripts/run-evals.ts`:
 *
 * - `readNpmTarEntryType`'s parameter was widened from `number` to
 *   `number | undefined` (the value comes from `header[156]`, a Buffer
 *   index).
 * - `validateTarHeaderChecksum`'s summing loop gained a `header[index] ?? 0`
 *   default (also a Buffer index).
 *
 * Neither `header[156]` nor `header[index]` can actually be `undefined`
 * through the reachable public API: `readValidatedNpmTarEntries` only calls
 * into `parseNpmTarEntry` when `offset + 512 <= archive.length`, so `header`
 * is always a full 512-byte `Buffer.subarray`, and every index read is
 * in-bounds. That loop invariant is exactly why the fix is a type-only
 * correction and not a behavior change \u2014 the narrowest *reachable*
 * equivalent is this: an entry whose type-flag byte is a value tar readers
 * do not recognize as `file`/`directory` must still fail closed via
 * `artifactFailure('artifact_resolution')`, the same fallthrough branch that
 * would also run for a hypothetical `undefined` typeFlag. This is verified
 * end-to-end through the exported `validateNpmTarball`, not by calling the
 * unexported header-parsing helpers directly.
 */

function writeOctal(
  buffer: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`
  buffer.write(encoded, offset, length, 'ascii')
}

/** Builds one 512-byte ustar header block (+ padded content) with a
 * caller-controlled type-flag byte, so tests can construct both recognized
 * (file/directory) and unrecognized (e.g. fifo, char device) entry types. */
function tarBlock(name: string, typeFlag: number, content = ''): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  writeOctal(block, 100, 8, 0o644)
  writeOctal(block, 108, 8, 0)
  writeOctal(block, 116, 8, 0)
  const contentBuffer = Buffer.from(content, 'utf8')
  writeOctal(block, 124, 12, contentBuffer.length)
  writeOctal(block, 136, 12, 0)
  block.fill(0x20, 148, 156)
  block[156] = typeFlag
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  const checksum = block.reduce((sum, byte) => sum + byte, 0)
  writeOctal(block, 148, 8, checksum)
  return Buffer.concat([
    block,
    contentBuffer,
    Buffer.alloc((512 - (contentBuffer.length % 512)) % 512),
  ])
}

function writeTarball(parentDir: string, entries: readonly Buffer[]): string {
  const archivePath = path.join(parentDir, 'fixture.tgz')
  const body = Buffer.concat([...entries, Buffer.alloc(1024)])
  fs.writeFileSync(archivePath, gzipSync(body))
  return archivePath
}

describe('run-evals npm tarball header parsing', () => {
  test('accepts a well-formed file entry (positive control)', () => {
    const parentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'run-evals-tar-ok-'),
    )
    try {
      const archivePath = writeTarball(parentDir, [
        tarBlock('package/index.js', 0x30, 'export default 1'),
      ])
      const result = validateNpmTarball(archivePath)
      expect(result.entries).toHaveLength(1)
      expect(result.entries[0]?.path).toBe('index.js')
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('fails closed on an entry with an unrecognized type-flag byte instead of defaulting to file/directory', () => {
    const parentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'run-evals-tar-badtype-'),
    )
    try {
      // 0x39 ('9') is not a ustar type flag this parser recognizes as file
      // (0/0x30) or directory (0x35) — this is the same fallthrough branch
      // that a hypothetical undefined typeFlag would also hit.
      const archivePath = writeTarball(parentDir, [
        tarBlock('package/weird-entry', 0x39, 'x'),
      ])
      expect(() => validateNpmTarball(archivePath)).toThrow(
        /artifact_resolution/,
      )
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('fails closed on a corrupted header checksum', () => {
    const parentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'run-evals-tar-badsum-'),
    )
    try {
      const block = tarBlock('package/index.js', 0x30, 'export default 1')
      // Corrupt one content byte after the checksum was computed so the
      // stored checksum no longer matches the header bytes.
      block[0] = block[0] === 0x70 ? 0x71 : 0x70
      const archivePath = writeTarball(parentDir, [block])
      expect(() => validateNpmTarball(archivePath)).toThrow(
        /artifact_resolution/,
      )
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })
})
