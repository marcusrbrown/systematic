import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findStaleEntries,
  readManifest,
  type SyncManifest,
  validateManifest,
  writeManifest,
} from '../../src/lib/manifest.ts'

describe('manifest', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  const validManifest: SyncManifest = {
    $schema: './sync-manifest.schema.json',
    sources: {
      cep: {
        repo: 'EveryInc/compound-engineering-plugin',
        branch: 'main',
        url: 'https://github.com/EveryInc/compound-engineering-plugin',
      },
    },
    definitions: {
      'skills/brainstorming': {
        source: 'cep',
        upstream_path:
          'plugins/compound-engineering/skills/brainstorming/SKILL.md',
        upstream_commit: 'abc123',
        synced_at: '2026-02-09T00:00:00Z',
        notes: 'Adapted tool names and paths',
      },
    },
  }

  describe('readManifest', () => {
    test('reads valid manifest', () => {
      const filePath = path.join(testDir, 'manifest.json')
      fs.writeFileSync(filePath, JSON.stringify(validManifest, null, 2))

      const result = readManifest(filePath)
      expect(result).not.toBeNull()
      expect(result?.sources.cep.repo).toBe(
        'EveryInc/compound-engineering-plugin',
      )
      expect(result?.definitions['skills/brainstorming'].source).toBe('cep')
    })

    test('returns null for missing file', () => {
      const result = readManifest(path.join(testDir, 'nonexistent.json'))
      expect(result).toBeNull()
    })

    test('returns null for invalid JSON', () => {
      const filePath = path.join(testDir, 'bad.json')
      fs.writeFileSync(filePath, '{not valid json')

      const result = readManifest(filePath)
      expect(result).toBeNull()
    })

    test('returns null when schema validation fails', () => {
      const filePath = path.join(testDir, 'invalid.json')
      fs.writeFileSync(filePath, JSON.stringify({ sources: 'not-an-object' }))

      const result = readManifest(filePath)
      expect(result).toBeNull()
    })
  })

  describe('validateManifest', () => {
    test('validates correct manifest structure', () => {
      expect(validateManifest(validManifest)).toBe(true)
    })

    test('validates empty manifest', () => {
      expect(validateManifest({ sources: {}, definitions: {} })).toBe(true)
    })

    test('rejects non-object', () => {
      expect(validateManifest('string')).toBe(false)
      expect(validateManifest(null)).toBe(false)
      expect(validateManifest(42)).toBe(false)
    })

    test('rejects missing sources', () => {
      expect(validateManifest({ definitions: {} })).toBe(false)
    })

    test('rejects missing definitions', () => {
      expect(validateManifest({ sources: {} })).toBe(false)
    })

    test('rejects invalid source entry', () => {
      expect(
        validateManifest({
          sources: { cep: { repo: 'test' } },
          definitions: {},
        }),
      ).toBe(false)
    })

    test('rejects invalid definition entry', () => {
      expect(
        validateManifest({
          sources: {},
          definitions: { 'skills/test': { source: 'cep' } },
        }),
      ).toBe(false)
    })
  })

  describe('writeManifest', () => {
    test('writes manifest with stable formatting', () => {
      const filePath = path.join(testDir, 'output.json')
      writeManifest(filePath, validManifest)

      const raw = fs.readFileSync(filePath, 'utf8')
      expect(raw.endsWith('\n')).toBe(true)

      const parsed = JSON.parse(raw)
      expect(parsed.sources.cep.repo).toBe(
        'EveryInc/compound-engineering-plugin',
      )
    })

    test('round-trips through read', () => {
      const filePath = path.join(testDir, 'roundtrip.json')
      writeManifest(filePath, validManifest)

      const result = readManifest(filePath)
      expect(result).toEqual(validManifest)
    })
  })

  describe('findStaleEntries', () => {
    test('detects stale entries', () => {
      const stale = findStaleEntries(validManifest, [])
      expect(stale).toEqual(['skills/brainstorming'])
    })

    test('returns empty when all entries exist', () => {
      const stale = findStaleEntries(validManifest, ['skills/brainstorming'])
      expect(stale).toEqual([])
    })

    test('returns empty for empty manifest', () => {
      const empty: SyncManifest = {
        sources: {},
        definitions: {},
      }
      const stale = findStaleEntries(empty, [])
      expect(stale).toEqual([])
    })
  })
})
