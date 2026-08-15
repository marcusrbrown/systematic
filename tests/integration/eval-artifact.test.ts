import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  assertInstalledResolutionPath,
  cleanupEvalFixture,
  createEvalFixture,
  type EvalFixture,
  extractValidatedNpmTarball,
  packInstalledArtifact,
  resolveInstalledPluginEntry,
  validateNpmTarball,
} from '../../scripts/run-evals.ts'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')

interface TarEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'hardlink' | 'fifo' | 'char'
  content?: string
  linkName?: string
}

function writeOctal(
  buffer: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`
  buffer.write(encoded, offset, length, 'ascii')
}

function tarTypeFlag(type: TarEntry['type']): number {
  switch (type) {
    case 'file':
      return 0x30
    case 'directory':
      return 0x35
    case 'symlink':
      return 0x32
    case 'hardlink':
      return 0x31
    case 'fifo':
      return 0x36
    case 'char':
      return 0x33
  }
}

function tarBlock(entry: TarEntry): Buffer {
  const block = Buffer.alloc(512)
  block.write(entry.name, 0, 100, 'utf8')
  writeOctal(block, 100, 8, entry.type === 'directory' ? 0o755 : 0o644)
  writeOctal(block, 108, 8, 0)
  writeOctal(block, 116, 8, 0)
  const content = Buffer.from(entry.content ?? '', 'utf8')
  writeOctal(block, 124, 12, content.length)
  writeOctal(block, 136, 12, 0)
  block.fill(0x20, 148, 156)
  block[156] = tarTypeFlag(entry.type)
  if (entry.linkName) block.write(entry.linkName, 157, 100, 'utf8')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  const checksum = block.reduce((sum, byte) => sum + byte, 0)
  writeOctal(block, 148, 8, checksum)
  return Buffer.concat([
    block,
    content,
    Buffer.alloc((512 - (content.length % 512)) % 512),
  ])
}

function writeTarball(parentDir: string, entries: readonly TarEntry[]): string {
  const archivePath = path.join(parentDir, 'fixture.tgz')
  const body = Buffer.concat([...entries.map(tarBlock), Buffer.alloc(1024)])
  fs.writeFileSync(archivePath, gzipSync(body))
  return archivePath
}

function validPackageEntries(): TarEntry[] {
  return [
    {
      name: 'package/package.json',
      type: 'file',
      content: JSON.stringify({
        name: '@fro.bot/systematic',
        version: '1.2.3',
        main: './dist/index.js',
        exports: { '.': { import: './dist/index.js' } },
      }),
    },
    {
      name: 'package/dist/index.js',
      type: 'file',
      content: 'export default () => ({})',
    },
  ]
}

function freshFixture(parentDir: string): EvalFixture {
  return createEvalFixture({
    caseId: 'bootstrap-loading',
    mode: 'installed',
    runId: 'artifact-test',
    parentDir,
  })
}

describe('installed eval artifact boundary', () => {
  test('packs once, validates, extracts, and resolves the real package entry under the fixture root', () => {
    const parentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'eval-artifact-real-'),
    )
    const fixture = freshFixture(parentDir)
    try {
      const artifact = packInstalledArtifact({ rootDir: ROOT_DIR, fixture })
      const archive = validateNpmTarball(artifact.tarballPath)
      const resolved = resolveInstalledPluginEntry(fixture.packageRoot)

      expect(artifact.packageName).toBe('@fro.bot/systematic')
      expect(artifact.packageVersion).toMatch(/^\d+\.\d+\.\d+/)
      expect(artifact.tarballDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(archive.entries.length).toBeGreaterThan(0)
      expect(artifact.packageRoot).toBe(fixture.packageRoot)
      expect(artifact.moduleEntryId).toBe('dist/index.js')
      expect(resolved.moduleEntryId).toBe('dist/index.js')
      expect(fs.existsSync(resolved.moduleEntry)).toBe(true)
      expect(
        assertInstalledResolutionPath(
          fixture.packageRoot,
          resolved.moduleEntry,
        ),
      ).toBe(resolved.moduleEntry)
    } finally {
      cleanupEvalFixture(fixture)
      expect(fs.readdirSync(parentDir)).toEqual([])
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  }, 240_000)

  test('rejects malformed and unsafe archive entry categories before extraction', () => {
    const parentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'eval-artifact-hostile-'),
    )
    const destination = path.join(parentDir, 'extracted')
    fs.mkdirSync(destination)
    const cases: Array<{ label: string; entry: TarEntry }> = [
      {
        label: 'empty-name',
        entry: { name: '', type: 'file' },
      },
      {
        label: 'control-character',
        entry: { name: 'package/\u0001escape', type: 'file' },
      },
      { label: 'absolute-posix', entry: { name: '/tmp/escape', type: 'file' } },
      {
        label: 'absolute-windows',
        entry: { name: 'C:\\tmp\\escape', type: 'file' },
      },
      {
        label: 'unc',
        entry: { name: '\\\\server\\share\\escape', type: 'file' },
      },
      {
        label: 'file-url',
        entry: { name: 'file:///tmp/escape', type: 'file' },
      },
      {
        label: 'traversal',
        entry: { name: 'package/../escape', type: 'file' },
      },
      {
        label: 'dot-segment',
        entry: { name: 'package/./escape', type: 'file' },
      },
      {
        label: 'hardlink',
        entry: {
          name: 'package/link',
          type: 'hardlink',
          linkName: 'package/dist/index.js',
        },
      },
      {
        label: 'escaping-symlink',
        entry: {
          name: 'package/link',
          type: 'symlink',
          linkName: '../../outside',
        },
      },
      {
        label: 'symlink-chain',
        entry: {
          name: 'package/link',
          type: 'symlink',
          linkName: 'package/link-target',
        },
      },
      { label: 'special-fifo', entry: { name: 'package/fifo', type: 'fifo' } },
      {
        label: 'special-char',
        entry: { name: 'package/device', type: 'char' },
      },
      {
        label: 'safe-symlink-rejected',
        entry: {
          name: 'package/link',
          type: 'symlink',
          linkName: 'dist/index.js',
        },
      },
    ]

    try {
      for (const { label, entry } of cases) {
        const archivePath = writeTarball(parentDir, [entry])
        expect(
          () => extractValidatedNpmTarball(archivePath, destination),
          label,
        ).toThrow(/artifact_resolution|path_escape/)
        expect(fs.readdirSync(destination)).toEqual([])
      }

      const malformedPath = path.join(parentDir, 'malformed.tgz')
      fs.writeFileSync(malformedPath, gzipSync(Buffer.from('not-a-tar')))
      expect(() => validateNpmTarball(malformedPath)).toThrow(
        /artifact_resolution/,
      )
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('rejects missing package metadata, main/export, and dist content without source fallback', () => {
    const parentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'eval-artifact-missing-'),
    )
    const fixture = freshFixture(parentDir)
    try {
      const missingPackageJson = writeTarball(parentDir, [
        {
          name: 'package/dist/index.js',
          type: 'file',
          content: 'export default () => ({})',
        },
      ])
      extractValidatedNpmTarball(missingPackageJson, fixture.packageRoot)
      expect(() => resolveInstalledPluginEntry(fixture.packageRoot)).toThrow(
        /artifact_resolution/,
      )

      const missingMain = writeTarball(parentDir, [
        {
          name: 'package/package.json',
          type: 'file',
          content: JSON.stringify({
            name: '@fro.bot/systematic',
            version: '1.2.3',
          }),
        },
        {
          name: 'package/dist/index.js',
          type: 'file',
          content: 'export default () => ({})',
        },
      ])
      extractValidatedNpmTarball(missingMain, fixture.packageRoot)
      expect(() => resolveInstalledPluginEntry(fixture.packageRoot)).toThrow(
        /artifact_resolution/,
      )

      const missingDist = writeTarball(parentDir, [
        {
          name: 'package/package.json',
          type: 'file',
          content: JSON.stringify({
            name: '@fro.bot/systematic',
            version: '1.2.3',
            main: './dist/index.js',
          }),
        },
      ])
      extractValidatedNpmTarball(missingDist, fixture.packageRoot)
      expect(() => resolveInstalledPluginEntry(fixture.packageRoot)).toThrow(
        /artifact_resolution/,
      )

      expect(() =>
        assertInstalledResolutionPath(
          fixture.packageRoot,
          path.join(ROOT_DIR, 'src/index.ts'),
        ),
      ).toThrow(/path_escape/)
    } finally {
      cleanupEvalFixture(fixture)
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('rejects package roots under ancestor node_modules fallback paths', () => {
    const parentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'eval-artifact-ancestor-'),
    )
    const packageRoot = path.join(
      parentDir,
      'node_modules',
      '@fro.bot',
      'systematic',
    )
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true })

    try {
      expect(() =>
        assertInstalledResolutionPath(
          packageRoot,
          path.join(packageRoot, 'dist/index.js'),
        ),
      ).toThrow('eval-artifact:path_escape')
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('rejects external ancestor node_modules fallback while allowing fixture-local dependencies', () => {
    const parentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'eval-artifact-external-ancestor-'),
    )
    const packageRoot = path.join(parentDir, 'run', 'package')
    const packageEntry = path.join(packageRoot, 'dist/index.js')
    fs.mkdirSync(path.dirname(packageEntry), { recursive: true })
    fs.writeFileSync(packageEntry, 'export default () => ({})')
    fs.mkdirSync(path.join(packageRoot, 'node_modules', 'declared-dep'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(parentDir, 'node_modules', 'undeclared-dep'), {
      recursive: true,
    })

    try {
      expect(() =>
        assertInstalledResolutionPath(packageRoot, packageEntry),
      ).toThrow('eval-artifact:path_escape')

      fs.rmSync(path.join(parentDir, 'node_modules'), {
        recursive: true,
        force: true,
      })
      expect(assertInstalledResolutionPath(packageRoot, packageEntry)).toBe(
        fs.realpathSync(packageEntry),
      )
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('validates a safe internal package archive and keeps extracted paths canonical', () => {
    const parentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'eval-artifact-safe-'),
    )
    const fixture = freshFixture(parentDir)
    try {
      const archivePath = writeTarball(parentDir, validPackageEntries())
      const digest = createHash('sha256')
        .update(fs.readFileSync(archivePath))
        .digest('hex')
      extractValidatedNpmTarball(archivePath, fixture.packageRoot)
      const artifact = resolveInstalledPluginEntry(fixture.packageRoot)

      expect(validateNpmTarball(archivePath).digest).toBe(digest)
      expect(artifact.moduleEntry.startsWith(fixture.packageRoot)).toBe(true)
      expect(fs.realpathSync(artifact.moduleEntry)).toBe(artifact.moduleEntry)
    } finally {
      cleanupEvalFixture(fixture)
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })

  test('rejects compressed tar output over the production size cap before validation', () => {
    const parentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'eval-artifact-bomb-'),
    )
    try {
      const maxOutputBytes = 128 * 1024 * 1024
      const oversizedBody = Buffer.alloc(maxOutputBytes + 16 * 1024 * 1024)
      const archivePath = path.join(parentDir, 'compressed-bomb.tgz')
      fs.writeFileSync(archivePath, gzipSync(oversizedBody))

      const beforeArrayBuffers = process.memoryUsage().arrayBuffers
      expect(() => validateNpmTarball(archivePath)).toThrow(
        /eval-artifact:artifact_resolution/,
      )
      const arrayBuffersDelta =
        process.memoryUsage().arrayBuffers - beforeArrayBuffers
      expect(arrayBuffersDelta).toBeLessThan(maxOutputBytes + 8 * 1024 * 1024)
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true })
    }
  })
})
