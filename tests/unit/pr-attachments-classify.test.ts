import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const SCRIPT_PATH = path.join(
  ROOT_DIR,
  'skills/pr-attachments/scripts/pr-attachments.mjs',
)

const SVG_MESSAGE = 'SVG is not supported by this skill'
const CANARY = 'SECRET-CANARY-0d9f3b7a'
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

// ── Fixture builders: real, minimal image files ────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

/** A valid 1x1 RGB PNG, optionally with extra chunks before the pixel data. */
function makePng(extraChunks: readonly Buffer[] = []): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ])
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    ...extraChunks,
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * A minimal JPEG: SOI, JFIF APP0, an optional extra APP1 segment, a one
 * component scan whose entropy data holds a stuffed FF00 and a restart
 * marker, then EOI.
 */
function makeJpeg(app1Payload: Buffer = Buffer.alloc(0)): Buffer {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'ascii'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ])
  const app1 =
    app1Payload.length === 0
      ? Buffer.alloc(0)
      : Buffer.concat([
          Buffer.from([0xff, 0xe1]),
          Buffer.from([
            (app1Payload.length + 2) >> 8,
            (app1Payload.length + 2) & 0xff,
          ]),
          app1Payload,
        ])
  const scanHeader = Buffer.from([
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  ])
  const entropy = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    app1,
    scanHeader,
    entropy,
    Buffer.from([0xff, 0xd9]),
  ])
}

/** A 1x1 GIF with a graphic control extension and one image block. */
function makeGif(version: '87a' | '89a' = '89a'): Buffer {
  return Buffer.concat([
    Buffer.from(`GIF${version}`, 'ascii'),
    Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x2c, 0, 0, 0, 0, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0x02, 0x02, 0x4c, 0x01, 0x00]),
    Buffer.from([0x3b]),
  ])
}

/** A RIFF/WEBP container with one made-up VP8L chunk. */
function makeWebp(): Buffer {
  const chunkData = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
  const chunkHeader = Buffer.alloc(8)
  chunkHeader.write('VP8L', 0, 'ascii')
  chunkHeader.writeUInt32LE(chunkData.length, 4)
  const body = Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    chunkHeader,
    chunkData,
  ])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

/** A RIFF file that is not WebP, so only the first four bytes match. */
function makeWav(): Buffer {
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), Buffer.alloc(16)])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

function blobSha(bytes: Buffer): string {
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex')
}

// ── Response parsing: no `as` casts, narrow from unknown ──────────────────

interface Entry {
  readonly source: string
  readonly destination: string
  readonly type: string
  readonly bytes: number
  readonly blob_sha: string
  readonly status: string
}

interface Rejection {
  readonly source: string
  readonly reason: string
  readonly message: string
}

interface Ask {
  readonly code: string
  readonly destination?: string
  readonly sources?: readonly string[]
  readonly source?: string
}

interface Warning {
  readonly source: string
  readonly code: string
  readonly bytes: number
}

interface ClassifyResponse {
  readonly schema_version: number
  readonly operation: string
  readonly result: string
  readonly topic: { readonly slug: string; readonly source: string } | null
  readonly entries: readonly Entry[]
  readonly rejections: readonly Rejection[]
  readonly asks: readonly Ask[]
  readonly warnings: readonly Warning[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new Error(`expected string field ${key}`)
  }
  return value
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number') {
    throw new Error(`expected number field ${key}`)
  }
  return value
}

function arrayField(
  record: Record<string, unknown>,
  key: string,
): readonly unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) {
    throw new Error(`expected array field ${key}`)
  }
  return value
}

function recordItem(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected an object item')
  }
  return value
}

function parseAsk(value: unknown): Ask {
  const record = recordItem(value)
  const sources = record.sources
  return {
    code: stringField(record, 'code'),
    ...(typeof record.destination === 'string'
      ? { destination: record.destination }
      : {}),
    ...(typeof record.source === 'string' ? { source: record.source } : {}),
    ...(Array.isArray(sources)
      ? {
          sources: sources.filter(
            (item): item is string => typeof item === 'string',
          ),
        }
      : {}),
  }
}

function parseClassify(stdout: string): ClassifyResponse {
  const parsed: unknown = JSON.parse(stdout)
  const record = recordItem(parsed)
  const topic = record.topic
  return {
    schema_version: numberField(record, 'schema_version'),
    operation: stringField(record, 'operation'),
    result: stringField(record, 'result'),
    topic: isRecord(topic)
      ? {
          slug: stringField(topic, 'slug'),
          source: stringField(topic, 'source'),
        }
      : null,
    entries: arrayField(record, 'entries').map((item) => {
      const entry = recordItem(item)
      return {
        source: stringField(entry, 'source'),
        destination: stringField(entry, 'destination'),
        type: stringField(entry, 'type'),
        bytes: numberField(entry, 'bytes'),
        blob_sha: stringField(entry, 'blob_sha'),
        status: stringField(entry, 'status'),
      }
    }),
    rejections: arrayField(record, 'rejections').map((item) => {
      const rejection = recordItem(item)
      return {
        source: stringField(rejection, 'source'),
        reason: stringField(rejection, 'reason'),
        message: stringField(rejection, 'message'),
      }
    }),
    asks: arrayField(record, 'asks').map(parseAsk),
    warnings: arrayField(record, 'warnings').map((item) => {
      const warning = recordItem(item)
      return {
        source: stringField(warning, 'source'),
        code: stringField(warning, 'code'),
        bytes: numberField(warning, 'bytes'),
      }
    }),
  }
}

// ── Process and filesystem harness ─────────────────────────────────────────

interface RawRun {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

function runHelper(
  args: readonly string[],
  stdin: string,
  cwd?: string,
): RawRun {
  const result = spawnSync('node', [SCRIPT_PATH, ...args], {
    input: stdin,
    encoding: 'utf8',
    ...(cwd === undefined ? {} : { cwd }),
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

interface ClassifyRun {
  readonly status: number | null
  readonly stderr: string
  readonly stdout: string
  readonly response: ClassifyResponse
}

function classify(input: unknown, cwd?: string): ClassifyRun {
  const raw = runHelper(['classify'], JSON.stringify(input), cwd)
  return {
    status: raw.status,
    stderr: raw.stderr,
    stdout: raw.stdout,
    response: parseClassify(raw.stdout),
  }
}

const tempDirs: string[] = []

function makeDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pr-attachments-classify-')),
  )
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      fs.chmodSync(dir, 0o755)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

function writeFile(dir: string, name: string, bytes: Buffer | string): string {
  const filePath = path.join(dir, name)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, bytes)
  return filePath
}

const unreadableFilesAreRefused = (() => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return false
  }
  const probeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pr-attachments-probe-'),
  )
  try {
    const probe = path.join(probeDir, 'probe')
    fs.writeFileSync(probe, 'x')
    fs.chmodSync(probe, 0o000)
    try {
      fs.readFileSync(probe)
      return false
    } catch {
      return true
    }
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true })
  }
})()

const mkfifoAvailable = (() => {
  const probe = spawnSync('which', ['mkfifo'], { encoding: 'utf8' })
  return probe.status === 0 && probe.stdout.trim().length > 0
})()

// ── Scenarios ──────────────────────────────────────────────────────────────

describe('classify: accepted formats', () => {
  it('accepts one file of each supported format and names it after its content', () => {
    const dir = makeDir()
    const files = [
      { name: 'a.png', bytes: makePng(), type: 'png', ext: 'png' },
      { name: 'b.jpg', bytes: makeJpeg(), type: 'jpeg', ext: 'jpg' },
      { name: 'c.gif', bytes: makeGif('87a'), type: 'gif', ext: 'gif' },
      { name: 'd.gif', bytes: makeGif('89a'), type: 'gif', ext: 'gif' },
      { name: 'e.webp', bytes: makeWebp(), type: 'webp', ext: 'webp' },
    ]
    const paths = files.map((file) => writeFile(dir, file.name, file.bytes))

    const run = classify({ paths, branch: 'feat/demo' })

    expect(run.status).toBe(0)
    expect(run.response.result).toBe('accepted')
    expect(run.response.entries).toHaveLength(5)
    for (const [index, file] of files.entries()) {
      const entry = run.response.entries[index]
      expect(entry?.type).toBe(file.type)
      expect(entry?.bytes).toBe(file.bytes.length)
      expect(entry?.destination).toBe(
        `docs/evidence/feat-demo/${path.basename(file.name, path.extname(file.name))}.${file.ext}`,
      )
    }
  })

  it('takes the destination extension from the content, not the source name', () => {
    const dir = makeDir()
    const jpegAsPng = writeFile(dir, 'photo.png', makeJpeg())
    const gifAsWebp = writeFile(dir, 'clip.webp', makeGif())
    const noExtension = writeFile(dir, 'shot', makePng())

    const run = classify({
      paths: [jpegAsPng, gifAsWebp, noExtension],
      branch: 'x',
    })

    expect(run.response.entries.map((entry) => entry.destination)).toEqual([
      'docs/evidence/x/photo.jpg',
      'docs/evidence/x/clip.gif',
      'docs/evidence/x/shot.png',
    ])
  })

  it('reports the git blob SHA for each file', () => {
    const dir = makeDir()
    const filePath = writeFile(dir, 'a.png', makePng())
    const expected = spawnSync('git', ['hash-object', filePath], {
      encoding: 'utf8',
    }).stdout.trim()

    const run = classify({ paths: [filePath], branch: 'x' })

    expect(run.response.entries[0]?.blob_sha).toBe(expected)
    expect(run.response.entries[0]?.blob_sha).toBe(blobSha(makePng()))
  })

  it('resolves relative paths against the working directory', () => {
    const dir = makeDir()
    writeFile(dir, 'shots/a.png', makePng())

    const run = classify({ paths: ['shots/a.png'], branch: 'x' }, dir)

    expect(run.status).toBe(0)
    expect(run.response.entries[0]?.source).toBe('shots/a.png')
  })

  it('returns identical bytes for identical input', () => {
    const dir = makeDir()
    const filePath = writeFile(dir, 'a.png', makePng())
    const input = { paths: [filePath], branch: 'feat/x' }

    expect(classify(input).stdout).toBe(classify(input).stdout)
  })
})

describe('classify: whole-batch rejection', () => {
  it('rejects a .env file renamed x.png and accepts nothing from the batch', () => {
    const dir = makeDir()
    const good = writeFile(dir, 'good.png', makePng())
    const secret = writeFile(dir, 'x.png', `API_KEY=${CANARY}\n`)

    const run = classify({ paths: [good, secret], branch: 'x' })

    expect(run.status).toBe(1)
    expect(run.response.result).toBe('rejected')
    expect(run.response.entries).toEqual([])
    expect(run.response.rejections).toHaveLength(1)
    expect(run.response.rejections[0]?.source).toBe(secret)
    expect(run.response.rejections[0]?.reason).toBe('unsupported-type')
  })

  it('rejects an SVG named .png with the not-supported message', () => {
    const dir = makeDir()
    const svg = writeFile(
      dir,
      'logo.png',
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    )

    const run = classify({ paths: [svg], branch: 'x' })

    expect(run.status).toBe(1)
    expect(run.response.rejections[0]?.reason).toBe('svg-not-supported')
    expect(run.response.rejections[0]?.message).toBe(SVG_MESSAGE)
  })

  it('recognises an SVG behind a BOM, an XML prolog, a comment and a doctype', () => {
    const dir = makeDir()
    const svg = writeFile(
      dir,
      'logo.webp',
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          '\n  <?xml version="1.0"?>\n<!-- exported -->\n' +
            '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n' +
            '<SVG xmlns="http://www.w3.org/2000/svg"></SVG>',
        ),
      ]),
    )

    const run = classify({ paths: [svg], branch: 'x' })

    expect(run.response.rejections[0]?.reason).toBe('svg-not-supported')
  })

  it('recognises an SVG behind a doctype with an internal subset', () => {
    const dir = makeDir()
    const svg = writeFile(
      dir,
      'logo.gif',
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          '<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported -->\n' +
            '<!doctype svg [ <!ENTITY a "b"> ]>\n' +
            '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        ),
      ]),
    )

    const run = classify({ paths: [svg], branch: 'x' })

    expect(run.response.rejections[0]?.reason).toBe('svg-not-supported')
  })

  it.each([['<SVG/>'], ['<Svg>'], ['<svg\n  width="1"/>']])(
    'recognises the root element %p in any letter case',
    (markup) => {
      const dir = makeDir()
      const svg = writeFile(dir, 'logo.png', markup)

      const run = classify({ paths: [svg], branch: 'x' })

      expect(run.response.rejections[0]?.reason).toBe('svg-not-supported')
    },
  )

  it.each([
    ['an unterminated XML declaration', '<?xml version="1.0"<svg/>'],
    ['an unterminated comment', '<!-- never closed <svg/>'],
    ['an unterminated doctype', '<!DOCTYPE svg <svg/>'],
    ['an unterminated internal subset', '<!DOCTYPE svg [ <svg/>'],
    ['a root element name that only starts with svg', '<svgx/>'],
    ['a root element other than svg', '<html><svg/></html>'],
  ])('does not treat %s as an SVG', (_label, markup) => {
    const dir = makeDir()
    const file = writeFile(dir, 'notes.png', markup)

    const run = classify({ paths: [file], branch: 'x' })

    expect(run.response.rejections[0]?.reason).toBe('unsupported-type')
  })

  describe('hostile prolog repetition', () => {
    const REPETITIONS = 50_000
    const TIME_LIMIT_MS = 2000

    // Each shape opens a prolog item once, then repeats a fragment that closes
    // it and opens the next. A backtracking matcher takes exponential time on
    // these; a linear scanner finishes at once. The child process is killed
    // after a hard timeout so a regression fails instead of hanging the suite.
    const SHAPES: readonly (readonly [string, string, string])[] = [
      ['an XML declaration', '<?xml', '?><?xml'],
      ['a comment', '<!--', '--><!--'],
      ['a doctype', '<!doctype', ' ><!doctype'],
      ['a doctype with an internal subset', '<!doctype[', ']><!doctype['],
    ]

    it.each(SHAPES)(
      'classifies repeated %s items as not-SVG in linear time',
      (_label, opener, fragment) => {
        const dir = makeDir()
        const file = writeFile(
          dir,
          'hostile.png',
          opener + fragment.repeat(REPETITIONS),
        )
        const started = performance.now()
        const result = spawnSync('node', [SCRIPT_PATH, 'classify'], {
          input: JSON.stringify({ paths: [file], branch: 'x' }),
          encoding: 'utf8',
          timeout: 5000,
          killSignal: 'SIGKILL',
        })
        const elapsed = performance.now() - started

        expect(result.error).toBeUndefined()
        expect(result.signal).toBeNull()
        expect(result.status).toBe(1)
        expect(parseClassify(result.stdout).rejections[0]?.reason).toBe(
          'unsupported-type',
        )
        expect(elapsed).toBeLessThan(TIME_LIMIT_MS)
      },
      15_000,
    )
  })

  it('rejects the whole batch when one file fails, naming a reason for every failure', () => {
    const dir = makeDir()
    const good = writeFile(dir, 'good.png', makePng())
    const svg = writeFile(dir, 'a.svg', '<svg/>')
    const text = writeFile(dir, 'notes.png', 'plain text')
    const missing = path.join(dir, 'missing.png')

    const run = classify({ paths: [good, svg, text, missing], branch: 'x' })

    expect(run.status).toBe(1)
    expect(run.response.result).toBe('rejected')
    expect(run.response.entries).toEqual([])
    expect(
      run.response.rejections.map((rejection) => [
        rejection.source,
        rejection.reason,
      ]),
    ).toEqual([
      [svg, 'svg-not-supported'],
      [text, 'unsupported-type'],
      [missing, 'missing'],
    ])
  })

  it('rejects a RIFF file that is not WebP', () => {
    const dir = makeDir()
    const wav = writeFile(dir, 'sound.webp', makeWav())

    const run = classify({ paths: [wav], branch: 'x' })

    expect(run.response.rejections[0]?.reason).toBe('unsupported-type')
  })

  it('rejects an empty file', () => {
    const dir = makeDir()
    const empty = writeFile(dir, 'empty.png', Buffer.alloc(0))

    const run = classify({ paths: [empty], branch: 'x' })

    expect(run.response.rejections[0]?.reason).toBe('unsupported-type')
  })

  it('rejects a directory as not a file', () => {
    const dir = makeDir()
    fs.mkdirSync(path.join(dir, 'folder.png'))

    const run = classify({ paths: [path.join(dir, 'folder.png')], branch: 'x' })

    expect(run.response.rejections[0]?.reason).toBe('not-a-file')
  })

  it('rejects a FIFO as not a file without waiting for a writer', () => {
    if (!mkfifoAvailable) {
      return
    }
    const dir = makeDir()
    const fifo = path.join(dir, 'pipe.png')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)

    const result = spawnSync('node', [SCRIPT_PATH, 'classify'], {
      input: JSON.stringify({ paths: [fifo], branch: 'x' }),
      encoding: 'utf8',
      timeout: 10_000,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(parseClassify(result.stdout).rejections[0]?.reason).toBe(
      'not-a-file',
    )
  })

  it('gives a missing path and an unreadable path each their own reason', () => {
    if (!unreadableFilesAreRefused) {
      return
    }
    const dir = makeDir()
    const missing = path.join(dir, 'missing.png')
    const locked = writeFile(dir, 'locked.png', makePng())
    fs.chmodSync(locked, 0o000)

    const run = classify({ paths: [missing, locked], branch: 'x' })

    expect(run.status).toBe(1)
    expect(
      run.response.rejections.map((rejection) => rejection.reason),
    ).toEqual(['missing', 'unreadable'])
  })

  it('never echoes file contents, in a rejection or in an accepted batch', () => {
    const dir = makeDir()
    const secret = writeFile(dir, 'x.png', `API_KEY=${CANARY}\n`)
    const hidden = writeFile(
      dir,
      'ok.png',
      Buffer.concat([makePng(), Buffer.from(CANARY)]),
    )

    const rejected = classify({ paths: [secret], branch: 'x' })
    const accepted = classify({ paths: [hidden], branch: 'x' })

    for (const run of [rejected, accepted]) {
      expect(run.stdout).not.toContain(CANARY)
      expect(run.stderr).not.toContain(CANARY)
    }
    expect(accepted.status).toBe(0)
  })
})

describe('classify: size limits', () => {
  it('rejects a file one byte over the limit and accepts one exactly at it', () => {
    const dir = makeDir()
    const png = makePng()
    const filePath = writeFile(dir, 'a.png', png)

    const atLimit = classify({
      paths: [filePath],
      branch: 'x',
      max_bytes: png.length,
    })
    const overLimit = classify({
      paths: [filePath],
      branch: 'x',
      max_bytes: png.length - 1,
    })

    expect(atLimit.status).toBe(0)
    expect(atLimit.response.entries).toHaveLength(1)
    expect(overLimit.status).toBe(1)
    expect(overLimit.response.rejections[0]?.reason).toBe('too-large')
  })

  it('accepts a small file under the default limit and rejects it under a lowered one', () => {
    const dir = makeDir()
    const filePath = writeFile(dir, 'a.png', makePng())
    const lowered = classify({
      paths: [filePath],
      branch: 'x',
      max_bytes: 10,
    })
    const defaulted = classify({ paths: [filePath], branch: 'x' })

    expect(lowered.response.rejections[0]?.reason).toBe('too-large')
    expect(defaulted.status).toBe(0)
  })
})

// raw.githubusercontent.com serves a PNG as image/png up to exactly 10 MiB
// and as application/octet-stream from one byte more. These tests use the
// helper's real default, never an injected max_bytes.
describe('classify: the default limit is the 10 MiB GitHub serves as an image', () => {
  const TEN_MIB = 10 * 1024 * 1024

  /** A valid PNG of exactly `size` bytes: padded with one ancillary chunk. */
  function makePngOfSize(size: number): Buffer {
    const chunkOverhead = 12
    const base = makePng().length
    const png = makePng([
      pngChunk('prVt', Buffer.alloc(size - base - chunkOverhead)),
    ])
    expect(png.length).toBe(size)
    return png
  }

  it('accepts a file of exactly 10,485,760 bytes, with no size warning', () => {
    const dir = makeDir()
    const filePath = writeFile(dir, 'edge.png', makePngOfSize(TEN_MIB))

    const run = classify({ paths: [filePath], branch: 'x' })

    expect(run.status).toBe(0)
    expect(run.response.result).toBe('accepted')
    expect(run.response.entries.map((entry) => entry.bytes)).toEqual([TEN_MIB])
    expect(run.response.warnings).toEqual([])
  })

  it('rejects a file of 10,485,761 bytes as too-large', () => {
    const dir = makeDir()
    const filePath = writeFile(dir, 'edge.png', makePngOfSize(TEN_MIB + 1))

    const run = classify({ paths: [filePath], branch: 'x' })

    expect(run.status).toBe(1)
    expect(run.response.result).toBe('rejected')
    expect(run.response.rejections).toEqual([
      {
        source: filePath,
        reason: 'too-large',
        message: expect.any(String),
      },
    ])
  })

  it('rejects the whole batch when one file is over the limit', () => {
    const dir = makeDir()
    const small = writeFile(dir, 'small.png', makePng())
    const big = writeFile(dir, 'big.png', makePngOfSize(TEN_MIB + 1))

    const run = classify({ paths: [small, big], branch: 'x' })

    expect(run.status).toBe(1)
    expect(run.response.result).toBe('rejected')
    expect(run.response.entries).toEqual([])
    expect(run.response.rejections.map((item) => item.source)).toEqual([big])
  })

  it('no longer warns about a large file or reads warn_bytes', () => {
    const dir = makeDir()
    const filePath = writeFile(dir, 'a.png', makePng())

    const run = classify({ paths: [filePath], branch: 'x', warn_bytes: 1 })

    expect(run.status).toBe(0)
    expect(run.response.warnings).toEqual([])
  })
})

describe('classify: trailing data warnings', () => {
  function warnings(name: string, bytes: Buffer): readonly Warning[] {
    const dir = makeDir()
    const filePath = writeFile(dir, name, bytes)
    const run = classify({ paths: [filePath], branch: 'x' })
    expect(run.status).toBe(0)
    return run.response.warnings
  }

  const TAIL = Buffer.from('APPENDED')

  it('accepts clean files of every format with no warning', () => {
    expect(warnings('a.png', makePng())).toEqual([])
    expect(warnings('a.jpg', makeJpeg())).toEqual([])
    expect(warnings('a.gif', makeGif())).toEqual([])
    expect(warnings('a.webp', makeWebp())).toEqual([])
  })

  it('warns about data appended after PNG IEND, and counts the bytes', () => {
    const found = warnings('a.png', Buffer.concat([makePng(), TAIL]))

    expect(found.map((warning) => [warning.code, warning.bytes])).toEqual([
      ['trailing-data', TAIL.length],
    ])
  })

  it('warns about data appended after the JPEG end marker', () => {
    const found = warnings('a.jpg', Buffer.concat([makeJpeg(), TAIL]))

    expect(found.map((warning) => [warning.code, warning.bytes])).toEqual([
      ['trailing-data', TAIL.length],
    ])
  })

  it('warns about data appended after the GIF trailer', () => {
    const found = warnings('a.gif', Buffer.concat([makeGif(), TAIL]))

    expect(found.map((warning) => [warning.code, warning.bytes])).toEqual([
      ['trailing-data', TAIL.length],
    ])
  })

  it('warns about data appended after the WebP container', () => {
    const found = warnings('a.webp', Buffer.concat([makeWebp(), TAIL]))

    expect(found.map((warning) => [warning.code, warning.bytes])).toEqual([
      ['trailing-data', TAIL.length],
    ])
  })

  it('does not take IEND text inside a PNG chunk for the end of the image', () => {
    const decoy = pngChunk('tEXt', Buffer.from('Comment\0IEND'))
    const clean = makePng([decoy])

    expect(warnings('a.png', clean)).toEqual([])
    expect(
      warnings('b.png', Buffer.concat([clean, TAIL])).map(
        (warning) => warning.bytes,
      ),
    ).toEqual([TAIL.length])
  })

  it('does not take an embedded JPEG end marker for the end of the image', () => {
    const thumbnail = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00])
    const clean = makeJpeg(thumbnail)

    expect(warnings('a.jpg', clean)).toEqual([])
    expect(
      warnings('b.jpg', Buffer.concat([clean, TAIL])).map(
        (warning) => warning.bytes,
      ),
    ).toEqual([TAIL.length])
  })

  it('accepts a file with only a signature, without a warning or a crash', () => {
    const signatureOnly = makePng().subarray(0, 8)

    expect(warnings('a.png', signatureOnly)).toEqual([])
  })
})

describe('classify: topic naming', () => {
  function slugFor(input: { branch?: string; topic?: string }): ClassifyRun {
    const dir = makeDir()
    const filePath = writeFile(dir, 'a.png', makePng())
    return classify({ paths: [filePath], ...input })
  }

  it('slugs a branch name and keeps feat/x and fix/x apart', () => {
    expect(slugFor({ branch: 'feat/x' }).response.topic).toEqual({
      slug: 'feat-x',
      source: 'branch',
    })
    expect(slugFor({ branch: 'fix/x' }).response.topic).toEqual({
      slug: 'fix-x',
      source: 'branch',
    })
  })

  it('lowercases, normalises with NFKC and collapses separator runs', () => {
    expect(
      slugFor({ branch: 'Feature/Add_Login  Screen!' }).response.topic?.slug,
    ).toBe('feature-add-login-screen')
    expect(slugFor({ branch: 'ＦＥＡＴ/ｘ' }).response.topic?.slug).toBe(
      'feat-x',
    )
    expect(slugFor({ branch: 'ﬁx/y' }).response.topic?.slug).toBe('fix-y')
  })

  it('truncates to 60 characters and never leaves a trailing separator', () => {
    expect(slugFor({ branch: 'a'.repeat(100) }).response.topic?.slug).toBe(
      'a'.repeat(60),
    )
    expect(
      slugFor({ branch: `${'a'.repeat(59)}/b` }).response.topic?.slug,
    ).toBe('a'.repeat(59))
  })

  it('asks for a topic when the branch yields an empty slug', () => {
    const run = slugFor({ branch: '///--' })

    expect(run.status).toBe(1)
    expect(run.response.result).toBe('needs-input')
    expect(run.response.entries).toEqual([])
    expect(run.response.asks.map((ask) => ask.code)).toEqual(['empty-topic'])
  })

  it('runs a user-supplied topic through the same slug function and returns it', () => {
    const run = slugFor({ topic: 'My Demo / v2' })

    expect(run.status).toBe(0)
    expect(run.response.topic).toEqual({ slug: 'my-demo-v2', source: 'topic' })
    expect(run.response.entries[0]?.destination).toBe(
      'docs/evidence/my-demo-v2/a.png',
    )
  })

  it('prefers the user topic over the branch', () => {
    const run = slugFor({ branch: 'feat/x', topic: 'chosen' })

    expect(run.response.topic).toEqual({ slug: 'chosen', source: 'topic' })
  })

  it('never produces a slug with a separator, traversal, escape or leading dash', () => {
    const hostile = [
      '../../etc/passwd',
      'a/../b',
      '%2e%2e%2f',
      'page#fragment',
      '-rf',
      '--flag',
      'a..b',
      '.hidden',
      'back\\slash',
      'sp ace',
      'line\nbreak',
      'tab\tbreak',
      '`tick`',
      '](x)',
      '<!-- x -->',
      'ünï/cödé',
    ]
    for (const topic of hostile) {
      const run = slugFor({ topic })
      const slug = run.response.topic?.slug ?? ''
      if (run.response.result === 'needs-input') {
        expect(run.response.asks.map((ask) => ask.code)).toEqual([
          'empty-topic',
        ])
        continue
      }
      expect(slug).toMatch(SLUG_PATTERN)
      expect(slug.length).toBeLessThanOrEqual(60)
      expect(slug).not.toContain('..')
      expect(slug).not.toMatch(/[/%#\\]/)
    }
  })
})

describe('classify: destination names', () => {
  it('slugs a source name to the safe alphabet and keeps its dots', () => {
    const dir = makeDir()
    const filePath = writeFile(
      dir,
      'Screen Shot 2026-10-22 at 10.30.45.PNG',
      makePng(),
    )

    const run = classify({ paths: [filePath], branch: 'x' })

    expect(run.response.entries[0]?.destination).toBe(
      'docs/evidence/x/screen-shot-2026-10-22-at-10.30.45.png',
    )
  })

  it('keeps markup, backticks and newlines in a source name out of the destination', () => {
    const dir = makeDir()
    const names = [
      'a](b).png',
      'x-->y.png',
      '<img>.png',
      'tick`tick.png',
      'line\nbreak.png',
      'a](b)-->`<x>\nz.png',
    ]
    const paths = names.map((name) => writeFile(dir, name, makePng()))

    const run = classify({ paths, branch: 'x' })

    expect(run.status).toBe(0)
    for (const entry of run.response.entries) {
      const name = path.posix.basename(entry.destination)
      expect(name).toMatch(NAME_PATTERN)
      expect(name).not.toContain('..')
      expect(path.posix.dirname(entry.destination)).toBe('docs/evidence/x')
    }
  })

  it('asks for a rename when a source name leaves nothing after slugging', () => {
    const dir = makeDir()
    const filePath = writeFile(dir, '!!!.png', makePng())

    const run = classify({ paths: [filePath], branch: 'x' })

    expect(run.status).toBe(1)
    expect(run.response.result).toBe('needs-input')
    expect(run.response.asks).toEqual([
      { code: 'empty-name', source: filePath },
    ])
  })

  it('stops and asks when two inputs map to one name in a batch', () => {
    const dir = makeDir()
    const first = writeFile(dir, 'a/shot.png', makePng())
    const second = writeFile(dir, 'b/Shot.PNG', makePng())

    const run = classify({ paths: [first, second], branch: 'x' })

    expect(run.status).toBe(1)
    expect(run.response.result).toBe('needs-input')
    expect(run.response.entries).toEqual([])
    expect(run.response.asks).toEqual([
      {
        code: 'duplicate-destination',
        destination: 'docs/evidence/x/shot.png',
        sources: [first, second],
      },
    ])
  })

  it('treats the same path listed twice as a duplicate', () => {
    const dir = makeDir()
    const filePath = writeFile(dir, 'a.png', makePng())

    const run = classify({ paths: [filePath, filePath], branch: 'x' })

    expect(run.response.asks.map((ask) => ask.code)).toEqual([
      'duplicate-destination',
    ])
  })
})

describe('classify: existing destinations', () => {
  it('reuses a destination that already holds identical bytes', () => {
    const dir = makeDir()
    const png = makePng()
    const filePath = writeFile(dir, 'a.png', png)

    const run = classify({
      paths: [filePath],
      branch: 'x',
      existing: { 'docs/evidence/x/a.png': blobSha(png) },
    })

    expect(run.status).toBe(0)
    expect(run.response.result).toBe('accepted')
    expect(run.response.entries[0]?.status).toBe('reused')
  })

  it('marks a destination with no existing file as new', () => {
    const dir = makeDir()
    const filePath = writeFile(dir, 'a.png', makePng())

    const run = classify({ paths: [filePath], branch: 'x', existing: {} })

    expect(run.response.entries[0]?.status).toBe('new')
  })

  it('stops and asks when the destination holds different bytes', () => {
    const dir = makeDir()
    const filePath = writeFile(dir, 'a.png', makePng())

    const run = classify({
      paths: [filePath],
      branch: 'x',
      existing: { 'docs/evidence/x/a.png': blobSha(makeJpeg()) },
    })

    expect(run.status).toBe(1)
    expect(run.response.result).toBe('needs-input')
    expect(run.response.entries).toEqual([])
    expect(run.response.asks).toEqual([
      {
        code: 'destination-conflict',
        destination: 'docs/evidence/x/a.png',
        sources: [filePath],
      },
    ])
  })
})

describe('classify: usage errors', () => {
  function expectUsageError(run: RawRun): void {
    expect(run.status).toBe(2)
    const parsed: unknown = JSON.parse(run.stdout)
    expect(isRecord(parsed)).toBe(true)
    if (isRecord(parsed)) {
      expect(parsed.result).toBe('usage-error')
      expect(typeof parsed.error).toBe('string')
    }
  }

  it('exits 2 for an empty path list', () => {
    expectUsageError(
      runHelper(['classify'], JSON.stringify({ paths: [], branch: 'x' })),
    )
  })

  it('exits 2 when paths is missing or holds a non-string', () => {
    expectUsageError(runHelper(['classify'], JSON.stringify({ branch: 'x' })))
    expectUsageError(
      runHelper(['classify'], JSON.stringify({ paths: [1], branch: 'x' })),
    )
  })

  it('exits 2 when neither a branch nor a topic is given', () => {
    expectUsageError(
      runHelper(['classify'], JSON.stringify({ paths: ['/tmp/a.png'] })),
    )
  })

  it('exits 2 for a limit that is not a positive integer', () => {
    for (const limit of [0, -1, 1.5, '10']) {
      expectUsageError(
        runHelper(
          ['classify'],
          JSON.stringify({
            paths: ['/tmp/a.png'],
            branch: 'x',
            max_bytes: limit,
          }),
        ),
      )
    }
  })

  it('exits 2 for malformed JSON without echoing it', () => {
    const run = runHelper(['classify'], `{"paths": ["${CANARY}"`)

    expectUsageError(run)
    expect(run.stdout).not.toContain(CANARY)
    expect(run.stderr).not.toContain(CANARY)
  })

  it('exits 2 for an unknown or missing subcommand without echoing it', () => {
    const unknown = runHelper([CANARY], '{}')
    const missing = runHelper([], '{}')

    expectUsageError(unknown)
    expect(unknown.stdout).not.toContain(CANARY)
    expectUsageError(missing)
  })
})

describe('classify: helper constraints', () => {
  it('imports only node: built-ins and no relative modules', () => {
    const source = fs.readFileSync(SCRIPT_PATH, 'utf8')
    const specifiers = [
      ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g),
      ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g),
    ].map((match) => match[1] ?? '')

    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier.startsWith('node:')).toBe(true)
    }
  })
})
