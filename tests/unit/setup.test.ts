import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import {
  isSetupError,
  PI_PACKAGE_IDENTIFIER,
  setupHarness,
} from '../../src/lib/setup.js'

function mkTempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-setup-test-'))
}

function expectSetupError(fn: () => unknown): void {
  try {
    fn()
    throw new Error('expected setupHarness to throw a SetupError')
  } catch (error) {
    expect(isSetupError(error)).toBe(true)
  }
}

describe('setupHarness', () => {
  describe('opencode target resolution', () => {
    it('prefers .opencode/opencode.jsonc when present', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.opencode'))
        fs.writeFileSync(
          path.join(cwd, '.opencode/opencode.jsonc'),
          '{\n  "plugin": []\n}\n',
        )
        fs.writeFileSync(path.join(cwd, 'opencode.json'), '{}')

        const result = setupHarness('opencode', cwd)
        expect(result.targetPath).toBe(
          path.join(cwd, '.opencode/opencode.jsonc'),
        )
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('falls back through precedence order to root opencode.json', () => {
      const cwd = mkTempCwd()
      try {
        fs.writeFileSync(path.join(cwd, 'opencode.json'), '{}')
        const result = setupHarness('opencode', cwd)
        expect(result.targetPath).toBe(path.join(cwd, 'opencode.json'))
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('creates root opencode.jsonc when no candidate exists', () => {
      const cwd = mkTempCwd()
      try {
        const result = setupHarness('opencode', cwd)
        expect(result.targetPath).toBe(path.join(cwd, 'opencode.jsonc'))
        expect(fs.existsSync(result.targetPath)).toBe(true)
        expect(result.status).toBe('configured')
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })
  })

  describe('opencode plugin/plugins mutation', () => {
    it('creates singular `plugin` array when neither field exists', () => {
      const cwd = mkTempCwd()
      try {
        fs.writeFileSync(path.join(cwd, 'opencode.json'), '{}\n')
        setupHarness('opencode', cwd)
        const written = fs.readFileSync(path.join(cwd, 'opencode.json'), 'utf8')
        const parsed = JSON.parse(written) as { plugin?: unknown[] }
        expect(parsed.plugin).toEqual(['@fro.bot/systematic'])
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('preserves comments when mutating existing plugin array (JSONC)', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.jsonc')
        fs.writeFileSync(
          filePath,
          '{\n  // keep this comment\n  "plugin": ["other-plugin"]\n}\n',
        )
        setupHarness('opencode', cwd)
        const written = fs.readFileSync(filePath, 'utf8')
        expect(written).toContain('// keep this comment')
        expect(written).toContain('other-plugin')
        expect(written).toContain('@fro.bot/systematic')
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('survives a comment-like substring inside a JSON string value', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({
          plugin: [],
          note: 'https://example.test/a/*literal*/?next=//value',
        })
        fs.writeFileSync(filePath, original)
        setupHarness('opencode', cwd)
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
          note?: string
        }
        expect(parsed.note).toBe(
          'https://example.test/a/*literal*/?next=//value',
        )
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('mutates a valid trailing-comma config successfully', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        fs.writeFileSync(filePath, '{\n  "plugin": ["foo",],\n}\n')
        setupHarness('opencode', cwd)
        const parsed = parseJsonc(fs.readFileSync(filePath, 'utf8')) as {
          plugin?: unknown[]
        }
        expect(parsed.plugin).toEqual(['foo', '@fro.bot/systematic'])
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed with zero writes when `plugins` (plural) is present, even alone', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({ plugins: ['foo'] })
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('opencode', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed with zero writes on a non-string `plugin` array entry (no tuple/object support)', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({ plugin: [['foo', { a: 1 }]] })
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('opencode', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed with zero writes on a literal duplicate top-level `plugin` key', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = '{"plugin": ["a"], "plugin": ["b"]}'
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('opencode', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed with zero writes on a literal duplicate top-level `plugins` key', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = '{"plugins": ["a"], "plugins": ["b"]}'
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('opencode', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('creates .opencode/opencode.jsonc, taking precedence over a coexisting root opencode.json', () => {
      const cwd = mkTempCwd()
      try {
        fs.writeFileSync(path.join(cwd, 'opencode.json'), '{}')
        const dotOpencodeDir = path.join(cwd, '.opencode')
        fs.mkdirSync(dotOpencodeDir)
        fs.writeFileSync(
          path.join(dotOpencodeDir, 'opencode.jsonc'),
          '{ "plugin": [] }',
        )
        const result = setupHarness('opencode', cwd)
        expect(result.targetPath).toBe(
          path.join(dotOpencodeDir, 'opencode.jsonc'),
        )
        expect(fs.readFileSync(path.join(cwd, 'opencode.json'), 'utf8')).toBe(
          '{}',
        )
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('treats bare identity as already configured and writes nothing', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({ plugin: ['@fro.bot/systematic'] })
        fs.writeFileSync(filePath, original)
        const before = fs.statSync(filePath).mtimeMs
        const result = setupHarness('opencode', cwd)
        expect(result.status).toBe('already-configured')
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
        expect(fs.existsSync(`${filePath}.bak`)).toBe(false)
        expect(fs.statSync(filePath).mtimeMs).toBe(before)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('treats versioned identity as already configured and preserves version', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({
          plugin: ['@fro.bot/systematic@1.2.3'],
        })
        fs.writeFileSync(filePath, original)
        const result = setupHarness('opencode', cwd)
        expect(result.status).toBe('already-configured')
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('does not treat a trailing bare `@` as already configured (adds a fresh entry instead)', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        fs.writeFileSync(
          filePath,
          JSON.stringify({ plugin: ['@fro.bot/systematic@'] }),
        )
        const result = setupHarness('opencode', cwd)
        expect(result.status).toBe('configured')
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed with zero writes when both plugin and plugins exist', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({ plugin: [], plugins: [] })
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('opencode', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
        expect(fs.existsSync(`${filePath}.bak`)).toBe(false)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed with zero writes when the selected field is non-array', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({ plugin: 'not-an-array' })
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('opencode', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed with zero writes on invalid entry shape', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({ plugin: [42] })
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('opencode', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed with zero writes on JSONC parse errors', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = '{ "plugin": [ "foo" '
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('opencode', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })
  })

  describe('pi settings.json mutation', () => {
    it('target is <cwd>/.pi/settings.json', () => {
      const cwd = mkTempCwd()
      try {
        const result = setupHarness('pi', cwd)
        expect(result.targetPath).toBe(path.join(cwd, '.pi/settings.json'))
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('creates `packages` array with npm: identifier when absent', () => {
      const cwd = mkTempCwd()
      try {
        const result = setupHarness('pi', cwd)
        const written = JSON.parse(
          fs.readFileSync(result.targetPath, 'utf8'),
        ) as { packages?: unknown[] }
        expect(written.packages).toEqual([PI_PACKAGE_IDENTIFIER])
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('appends to existing valid `packages` array with string and tagged object entries', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        const filePath = path.join(cwd, '.pi/settings.json')
        fs.writeFileSync(
          filePath,
          JSON.stringify({
            packages: ['npm:other-pkg', { source: 'npm:tagged-pkg' }],
          }),
        )
        setupHarness('pi', cwd)
        const written = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
          packages?: unknown[]
        }
        expect(written.packages).toEqual([
          'npm:other-pkg',
          { source: 'npm:tagged-pkg' },
          PI_PACKAGE_IDENTIFIER,
        ])
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('treats matching version/tag identity as already configured and preserves it', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        const filePath = path.join(cwd, '.pi/settings.json')
        const original = JSON.stringify({
          packages: [`${PI_PACKAGE_IDENTIFIER}@1.0.0`],
        })
        fs.writeFileSync(filePath, original)
        const result = setupHarness('pi', cwd)
        expect(result.status).toBe('already-configured')
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('does not treat a trailing bare `@` as already configured (adds a fresh entry instead)', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        const filePath = path.join(cwd, '.pi/settings.json')
        fs.writeFileSync(
          filePath,
          JSON.stringify({ packages: [`${PI_PACKAGE_IDENTIFIER}@`] }),
        )
        const result = setupHarness('pi', cwd)
        expect(result.status).toBe('configured')
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed with zero writes when `packages` is not an array', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        const filePath = path.join(cwd, '.pi/settings.json')
        const original = JSON.stringify({ packages: 'nope' })
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('pi', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed with zero writes on invalid entry shape', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        const filePath = path.join(cwd, '.pi/settings.json')
        const original = JSON.stringify({ packages: [{ notSource: true }] })
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('pi', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed with zero writes on malformed (non-JSON) settings.json', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        const filePath = path.join(cwd, '.pi/settings.json')
        const original = '{ not json'
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('pi', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('creates `packages` in existing settings.json that has no `packages` key, preserving other content', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        const filePath = path.join(cwd, '.pi/settings.json')
        fs.writeFileSync(filePath, JSON.stringify({ other: 'value' }))
        const result = setupHarness('pi', cwd)
        expect(result.status).toBe('configured')
        const written = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
          other?: string
          packages?: unknown[]
        }
        expect(written.other).toBe('value')
        expect(written.packages).toEqual([PI_PACKAGE_IDENTIFIER])
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('preserves a large-integer lexeme byte-for-byte via structural edit, not JSON.stringify round-trip', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        const filePath = path.join(cwd, '.pi/settings.json')
        fs.writeFileSync(
          filePath,
          '{\n  "bigNum": 9007199254740993,\n  "packages": []\n}\n',
        )
        setupHarness('pi', cwd)
        const written = fs.readFileSync(filePath, 'utf8')
        expect(written).toContain('9007199254740993')
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('a matching bare-source tagged object with no filters counts as already configured', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        const filePath = path.join(cwd, '.pi/settings.json')
        const original = JSON.stringify({
          packages: [{ source: PI_PACKAGE_IDENTIFIER }],
        })
        fs.writeFileSync(filePath, original)
        const result = setupHarness('pi', cwd)
        expect(result.status).toBe('already-configured')
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('a matching tagged object with an unrelated `prompts` filter still counts as already configured', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        const filePath = path.join(cwd, '.pi/settings.json')
        const original = JSON.stringify({
          packages: [{ source: PI_PACKAGE_IDENTIFIER, prompts: [] }],
        })
        fs.writeFileSync(filePath, original)
        const result = setupHarness('pi', cwd)
        expect(result.status).toBe('already-configured')
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed on a matching tagged object with `autoload: false`', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        const filePath = path.join(cwd, '.pi/settings.json')
        const original = JSON.stringify({
          packages: [{ source: PI_PACKAGE_IDENTIFIER, autoload: false }],
        })
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('pi', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed on a matching tagged object that filters `extensions`', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        const filePath = path.join(cwd, '.pi/settings.json')
        const original = JSON.stringify({
          packages: [{ source: PI_PACKAGE_IDENTIFIER, extensions: [] }],
        })
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('pi', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('fails closed on a matching tagged object that filters `skills`', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        const filePath = path.join(cwd, '.pi/settings.json')
        const original = JSON.stringify({
          packages: [{ source: PI_PACKAGE_IDENTIFIER, skills: [] }],
        })
        fs.writeFileSync(filePath, original)
        expectSetupError(() => setupHarness('pi', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })
  })

  describe('harness isolation', () => {
    it('setting up pi does not touch any opencode config file', () => {
      const cwd = mkTempCwd()
      try {
        fs.writeFileSync(path.join(cwd, 'opencode.json'), '{}')
        setupHarness('pi', cwd)
        expect(fs.readFileSync(path.join(cwd, 'opencode.json'), 'utf8')).toBe(
          '{}',
        )
        expect(fs.existsSync(path.join(cwd, 'opencode.json.bak'))).toBe(false)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('setting up opencode does not touch .pi/settings.json', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, '.pi'))
        fs.writeFileSync(path.join(cwd, '.pi/settings.json'), '{}')
        setupHarness('opencode', cwd)
        expect(
          fs.readFileSync(path.join(cwd, '.pi/settings.json'), 'utf8'),
        ).toBe('{}')
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })
  })

  describe('atomic writer safety', () => {
    it('writes an exact-bytes backup before mutating an existing target', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({ plugin: ['foo'] })
        fs.writeFileSync(filePath, original)
        setupHarness('opencode', cwd)
        expect(fs.readFileSync(`${filePath}.bak`, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('writes no backup for a newly created target', () => {
      const cwd = mkTempCwd()
      try {
        const result = setupHarness('opencode', cwd)
        expect(fs.existsSync(`${result.targetPath}.bak`)).toBe(false)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('refuses to follow a symlinked .bak path, leaving sentinel and target untouched', () => {
      if (process.platform === 'win32') return
      const cwd = mkTempCwd()
      const sentinelDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-setup-sentinel-'),
      )
      try {
        const sentinelPath = path.join(sentinelDir, 'sentinel.json')
        const sentinelContent = JSON.stringify({ untouched: true })
        fs.writeFileSync(sentinelPath, sentinelContent)

        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({ plugin: ['foo'] })
        fs.writeFileSync(filePath, original)
        fs.symlinkSync(sentinelPath, `${filePath}.bak`)

        expectSetupError(() => setupHarness('opencode', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
        expect(fs.readFileSync(sentinelPath, 'utf8')).toBe(sentinelContent)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
        fs.rmSync(sentinelDir, { recursive: true, force: true })
      }
    })

    it('refuses to clobber a pre-existing hardlinked .bak path, leaving the external sentinel untouched', () => {
      if (process.platform === 'win32') return
      const cwd = mkTempCwd()
      const sentinelDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-setup-hardlink-'),
      )
      try {
        const sentinelPath = path.join(sentinelDir, 'sentinel.json')
        const sentinelContent = JSON.stringify({ untouched: true })
        fs.writeFileSync(sentinelPath, sentinelContent)

        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({ plugin: ['foo'] })
        fs.writeFileSync(filePath, original)
        fs.linkSync(sentinelPath, `${filePath}.bak`)

        expectSetupError(() => setupHarness('opencode', cwd))
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
        expect(fs.readFileSync(sentinelPath, 'utf8')).toBe(sentinelContent)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
        fs.rmSync(sentinelDir, { recursive: true, force: true })
      }
    })

    it('rejects a non-regular target (directory) before any blocking read', () => {
      const cwd = mkTempCwd()
      try {
        fs.mkdirSync(path.join(cwd, 'opencode.json'))
        expectSetupError(() => setupHarness('opencode', cwd))
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('preserves the existing file mode after mutation', () => {
      if (process.platform === 'win32') return
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        fs.writeFileSync(filePath, JSON.stringify({ plugin: [] }))
        fs.chmodSync(filePath, 0o640)
        setupHarness('opencode', cwd)
        const mode = fs.statSync(filePath).mode & 0o777
        expect(mode).toBe(0o640)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('preserves an umask-sensitive exact mode (0o666) that writeFileSync alone cannot reproduce', () => {
      if (process.platform === 'win32') return
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        fs.writeFileSync(filePath, JSON.stringify({ plugin: ['foo'] }))
        fs.chmodSync(filePath, 0o666)
        setupHarness('opencode', cwd)
        const mode = fs.statSync(filePath).mode & 0o777
        expect(mode).toBe(0o666)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('stages both backup and target temp writes with flag: wx', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        fs.writeFileSync(filePath, JSON.stringify({ plugin: ['foo'] }))

        const capturedOptions: unknown[] = []
        const spyOps = {
          writeFileSync: (
            ...args: Parameters<typeof fs.writeFileSync>
          ): ReturnType<typeof fs.writeFileSync> => {
            capturedOptions.push(args[2])
            return fs.writeFileSync(...args)
          },
        }

        setupHarness('opencode', cwd, spyOps)

        expect(capturedOptions.length).toBeGreaterThan(0)
        for (const options of capturedOptions) {
          expect(options).toMatchObject({ flag: 'wx' })
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('rejects a `.pi` parent path that is a regular file, not a directory', () => {
      const cwd = mkTempCwd()
      try {
        fs.writeFileSync(path.join(cwd, '.pi'), 'not a directory')
        expectSetupError(() => setupHarness('pi', cwd))
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('rejects a symlinked parent directory', () => {
      if (process.platform === 'win32') return
      const cwd = mkTempCwd()
      const realDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'systematic-setup-outside-'),
      )
      try {
        fs.writeFileSync(
          path.join(realDir, 'opencode.jsonc'),
          '{ "plugin": [] }',
        )
        fs.symlinkSync(realDir, path.join(cwd, '.opencode'))
        expectSetupError(() => setupHarness('opencode', cwd))
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
        fs.rmSync(realDir, { recursive: true, force: true })
      }
    })

    it('rejects a symlinked target file', () => {
      if (process.platform === 'win32') return
      const cwd = mkTempCwd()
      const realFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-setup-target-')),
        'real.json',
      )
      try {
        fs.writeFileSync(realFile, '{}')
        fs.symlinkSync(realFile, path.join(cwd, 'opencode.json'))
        expectSetupError(() => setupHarness('opencode', cwd))
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
        fs.rmSync(path.dirname(realFile), { recursive: true, force: true })
      }
    })

    it('rejects an already-configured symlinked target without following it', () => {
      if (process.platform === 'win32') return
      const cwd = mkTempCwd()
      const realFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-setup-real-')),
        'real.json',
      )
      try {
        fs.writeFileSync(
          realFile,
          JSON.stringify({ plugin: ['@fro.bot/systematic'] }),
        )
        fs.symlinkSync(realFile, path.join(cwd, 'opencode.json'))
        expectSetupError(() => setupHarness('opencode', cwd))
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
        fs.rmSync(path.dirname(realFile), { recursive: true, force: true })
      }
    })

    it('rejects a dangling symlink target instead of silently falling through', () => {
      if (process.platform === 'win32') return
      const cwd = mkTempCwd()
      try {
        fs.symlinkSync(
          path.join(cwd, 'does-not-exist.json'),
          path.join(cwd, 'opencode.json'),
        )
        expectSetupError(() => setupHarness('opencode', cwd))
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('rejects a dangling symlink parent directory', () => {
      if (process.platform === 'win32') return
      const cwd = mkTempCwd()
      try {
        fs.symlinkSync(
          path.join(cwd, 'nonexistent-target-dir'),
          path.join(cwd, '.opencode'),
        )
        expectSetupError(() => setupHarness('opencode', cwd))
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('a rename failure leaves the original target unchanged and cleans up all temp files (backup and target)', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({ plugin: [] })
        fs.writeFileSync(filePath, original)

        const failingOps = {
          renameSync: () => {
            throw new Error('injected rename failure')
          },
        }

        expect(() => setupHarness('opencode', cwd, failingOps)).toThrow(
          /injected rename failure/,
        )
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
        expect(fs.existsSync(`${filePath}.bak`)).toBe(false)

        const remaining = fs
          .readdirSync(cwd)
          .filter((name) => name.startsWith('.opencode.json'))
        expect(remaining).toEqual([])
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('a backup rename failure cleans up the backup temp file and leaves the target unchanged', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({ plugin: ['foo'] })
        fs.writeFileSync(filePath, original)

        let renameCalls = 0
        const failingOps = {
          renameSync: (...args: [fs.PathLike, fs.PathLike]) => {
            renameCalls += 1
            // Fail only the first rename (the backup rename); a real target
            // rename should never be attempted once the backup step throws.
            if (renameCalls === 1) {
              throw new Error('injected backup rename failure')
            }
            return fs.renameSync(...args)
          },
        }

        expect(() => setupHarness('opencode', cwd, failingOps)).toThrow(
          /injected backup rename failure/,
        )
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
        expect(fs.existsSync(`${filePath}.bak`)).toBe(false)

        const remaining = fs
          .readdirSync(cwd)
          .filter((name) => name.startsWith('.opencode.json'))
        expect(remaining).toEqual([])
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('keeps the backup as recovery evidence when backup succeeds but the target rename fails', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        const original = JSON.stringify({ plugin: ['foo'] })
        fs.writeFileSync(filePath, original)

        let renameCalls = 0
        const failingOps = {
          renameSync: (...args: [fs.PathLike, fs.PathLike]) => {
            renameCalls += 1
            // Let the backup rename (1st) succeed; fail the target rename (2nd).
            if (renameCalls === 2) {
              throw new Error('injected target rename failure')
            }
            return fs.renameSync(...args)
          },
        }

        expect(() => setupHarness('opencode', cwd, failingOps)).toThrow(
          /injected target rename failure/,
        )
        expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
        expect(fs.readFileSync(`${filePath}.bak`, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })

    it('zero writes occur on a no-op rerun (write op is never invoked)', () => {
      const cwd = mkTempCwd()
      try {
        const filePath = path.join(cwd, 'opencode.json')
        fs.writeFileSync(filePath, JSON.stringify({ plugin: ['foo'] }))
        setupHarness('opencode', cwd)

        let writeCalls = 0
        let renameCalls = 0
        const countingOps = {
          writeFileSync: (...args: unknown[]) => {
            writeCalls += 1
            return (fs.writeFileSync as (...a: unknown[]) => void)(...args)
          },
          renameSync: (...args: unknown[]) => {
            renameCalls += 1
            return (fs.renameSync as (...a: unknown[]) => void)(...args)
          },
        }

        const result = setupHarness('opencode', cwd, countingOps)
        expect(result.status).toBe('already-configured')
        expect(writeCalls).toBe(0)
        expect(renameCalls).toBe(0)
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })
  })

  describe('CLI arg validation surface (unit-level)', () => {
    it('unknown harness value throws a SetupError', () => {
      const cwd = mkTempCwd()
      try {
        expectSetupError(() =>
          setupHarness(
            'bogus' as unknown as Parameters<typeof setupHarness>[0],
            cwd,
          ),
        )
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })
  })
})
