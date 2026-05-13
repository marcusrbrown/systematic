import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getAvailableModels } from '../../src/lib/model-availability.js'

function makeMockClient(
  result:
    | {
        data: {
          providers: Array<{ id: string; models: Record<string, unknown> }>
          default: Record<string, string>
        }
        error: undefined
      }
    | { data: undefined; error: unknown },
): { config: { providers: () => Promise<typeof result> } } {
  return {
    config: {
      providers: () => Promise.resolve(result),
    },
  }
}

function makeThrowingClient(err: unknown): {
  config: { providers: () => Promise<never> }
} {
  return {
    config: {
      providers: () => Promise.reject(err),
    },
  }
}

/** Client whose providers() never resolves — used for timeout tests. */
function makeHangingClient(): {
  config: { providers: () => Promise<never> }
} {
  return {
    config: {
      providers: () => new Promise<never>(() => {}),
    },
  }
}

/** SHA-1 hex of a string — mirrors `Hash.fast(url)` from OpenCode core. */
function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex')
}

describe('getAvailableModels', () => {
  let testDir: string
  let originalXdgCacheHome: string | undefined
  let originalOpenCodeModelsUrl: string | undefined
  let originalOsHomedir: (() => string) | undefined

  beforeEach(() => {
    testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-model-avail-test-'),
    )
    originalXdgCacheHome = process.env.XDG_CACHE_HOME
    originalOpenCodeModelsUrl = process.env.OPENCODE_MODELS_URL
    originalOsHomedir = os.homedir

    delete process.env.XDG_CACHE_HOME
    delete process.env.OPENCODE_MODELS_URL
  })

  afterEach(() => {
    if (originalXdgCacheHome !== undefined) {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome
    } else {
      delete process.env.XDG_CACHE_HOME
    }
    if (originalOpenCodeModelsUrl !== undefined) {
      process.env.OPENCODE_MODELS_URL = originalOpenCodeModelsUrl
    } else {
      delete process.env.OPENCODE_MODELS_URL
    }
    if (originalOsHomedir) {
      os.homedir = originalOsHomedir
    }
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  describe('happy path (API)', () => {
    test('returns Set of provider/model strings from connected providers', async () => {
      const client = makeMockClient({
        data: {
          providers: [
            {
              id: 'anthropic',
              models: {
                'claude-opus-4-7': {
                  id: 'claude-opus-4-7',
                  name: 'Claude Opus 4.7',
                },
                'claude-sonnet-4-6': {
                  id: 'claude-sonnet-4-6',
                  name: 'Claude Sonnet 4.6',
                },
              },
            },
            {
              id: 'openai',
              models: {
                'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' },
              },
            },
          ],
          default: {},
        },
        error: undefined,
      })

      const result = await getAvailableModels(client)

      expect(result.status).toBe('api')
      expect(result.models).toBeInstanceOf(Set)
      expect(result.models.size).toBe(3)
      expect(result.models.has('anthropic/claude-opus-4-7')).toBe(true)
      expect(result.models.has('anthropic/claude-sonnet-4-6')).toBe(true)
      expect(result.models.has('openai/gpt-5.5')).toBe(true)
    })
  })

  describe('happy path (fallback)', () => {
    test('reads models.json when client throws', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      const modelsJson = {
        anthropic: {
          models: {
            'claude-opus-4-7': {},
          },
        },
      }
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify(modelsJson),
      )

      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const client = makeThrowingClient(new Error('ECONNREFUSED'))

      const result = await getAvailableModels(client)

      expect(result.status).toBe('cache')
      expect(result.models).toBeInstanceOf(Set)
      expect(result.models.size).toBe(1)
      expect(result.models.has('anthropic/claude-opus-4-7')).toBe(true)
    })
  })

  describe('edge case: valid empty providers', () => {
    test('returns empty Set without consulting disk when providers array is empty', async () => {
      // Point XDG_CACHE_HOME to a non-existent dir — if fallback were triggered, it would
      // still return empty set, but we verify by checking the result is empty and no error
      // is thrown even with a bad cache path.
      process.env.XDG_CACHE_HOME = path.join(testDir, 'nonexistent')

      const client = makeMockClient({
        data: { providers: [], default: {} },
        error: undefined,
      })

      const result = await getAvailableModels(client)

      // Empty connected set is authoritative — status is 'api', not 'unknown'
      expect(result.status).toBe('api')
      expect(result.models).toBeInstanceOf(Set)
      expect(result.models.size).toBe(0)
    })

    test('does NOT read disk when API returns empty providers (spy verification)', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify({ anthropic: { models: { 'claude-opus-4-7': {} } } }),
      )
      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const readFileSyncSpy = spyOn(fs, 'readFileSync')

      const client = makeMockClient({
        data: { providers: [], default: {} },
        error: undefined,
      })

      const result = await getAvailableModels(client)

      expect(result.status).toBe('api')
      expect(result.models.size).toBe(0)
      // readFileSync should NOT have been called for models.json
      const modelsJsonCalls = readFileSyncSpy.mock.calls.filter(
        (args) =>
          typeof args[0] === 'string' && (args[0] as string).includes('models'),
      )
      expect(modelsJsonCalls.length).toBe(0)

      readFileSyncSpy.mockRestore()
    })
  })

  describe('edge case: cache path resolution', () => {
    test('uses XDG_CACHE_HOME when set', async () => {
      const cacheDir = path.join(testDir, 'xdg-cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify({ openai: { models: { 'gpt-5.5': {} } } }),
      )
      process.env.XDG_CACHE_HOME = path.join(testDir, 'xdg-cache')

      const client = makeThrowingClient(new Error('network error'))
      const result = await getAvailableModels(client)

      expect(result.status).toBe('cache')
      expect(result.models.has('openai/gpt-5.5')).toBe(true)
    })

    test('falls back to $HOME/.cache/opencode/models.json when XDG_CACHE_HOME is unset', async () => {
      const fakeHome = path.join(testDir, 'home')
      const cacheDir = path.join(fakeHome, '.cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify({ google: { models: { 'gemini-2-flash': {} } } }),
      )

      delete process.env.XDG_CACHE_HOME
      os.homedir = () => fakeHome

      const client = makeThrowingClient(new Error('network error'))
      const result = await getAvailableModels(client)

      expect(result.status).toBe('cache')
      expect(result.models.has('google/gemini-2-flash')).toBe(true)
    })
  })

  describe('edge case: OPENCODE_MODELS_URL', () => {
    test('prefers models-<sha1(url)>.json over models.json when OPENCODE_MODELS_URL is set', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })

      const url = 'https://custom.models.example.com/api.json'
      const urlHash = sha1Hex(url)

      // Write models.json with openai (should NOT be used when URL-derived file exists)
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify({ openai: { models: { 'gpt-5.5': {} } } }),
      )
      // Write models-<sha1(url)>.json with anthropic (should be used)
      fs.writeFileSync(
        path.join(cacheDir, `models-${urlHash}.json`),
        JSON.stringify({ anthropic: { models: { 'claude-opus-4-7': {} } } }),
      )

      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')
      process.env.OPENCODE_MODELS_URL = url

      const client = makeThrowingClient(new Error('network error'))
      const result = await getAvailableModels(client)

      // Should have used the URL-derived file (anthropic), not models.json (openai)
      expect(result.status).toBe('cache')
      expect(result.models.has('anthropic/claude-opus-4-7')).toBe(true)
      expect(result.models.has('openai/gpt-5.5')).toBe(false)
    })

    test('falls back to models.json when OPENCODE_MODELS_URL is set but no URL-derived file exists', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })

      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify({ openai: { models: { 'gpt-5.5': {} } } }),
      )

      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')
      process.env.OPENCODE_MODELS_URL =
        'https://custom.models.example.com/api.json'

      const client = makeThrowingClient(new Error('network error'))
      const result = await getAvailableModels(client)

      expect(result.status).toBe('cache')
      expect(result.models.has('openai/gpt-5.5')).toBe(true)
    })
  })

  describe('error path: API failure', () => {
    test('consults fallback when client.config.providers() throws', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify({ anthropic: { models: { 'claude-sonnet-4-6': {} } } }),
      )
      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const client = makeThrowingClient(new Error('ECONNREFUSED'))
      const result = await getAvailableModels(client)

      expect(result.status).toBe('cache')
      expect(result.models.has('anthropic/claude-sonnet-4-6')).toBe(true)
    })

    test('consults fallback when client returns error envelope', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify({ openai: { models: { 'gpt-5.5': {} } } }),
      )
      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const client = makeMockClient({
        data: undefined,
        error: { message: 'Unauthorized' },
      })
      const result = await getAvailableModels(client)

      expect(result.status).toBe('cache')
      expect(result.models.has('openai/gpt-5.5')).toBe(true)
    })
  })

  describe('error path: cache miss bucket', () => {
    test('returns empty Set when models.json is missing', async () => {
      process.env.XDG_CACHE_HOME = path.join(testDir, 'nonexistent-cache')

      const client = makeThrowingClient(new Error('network error'))
      const result = await getAvailableModels(client)

      expect(result.status).toBe('unknown')
      expect(result.models).toBeInstanceOf(Set)
      expect(result.models.size).toBe(0)
    })

    test('returns empty Set when models.json is zero-byte', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(path.join(cacheDir, 'models.json'), '')
      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const client = makeThrowingClient(new Error('network error'))
      const result = await getAvailableModels(client)

      expect(result.status).toBe('unknown')
      expect(result.models).toBeInstanceOf(Set)
      expect(result.models.size).toBe(0)
    })

    test('returns empty Set when models.json has corrupt JSON', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        '{ not valid json !!!',
      )
      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const client = makeThrowingClient(new Error('network error'))
      const result = await getAvailableModels(client)

      expect(result.status).toBe('unknown')
      expect(result.models).toBeInstanceOf(Set)
      expect(result.models.size).toBe(0)
    })

    test('returns empty Set when models.json has schema-mismatched content (array)', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify([1, 2, 3]),
      )
      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const client = makeThrowingClient(new Error('network error'))
      const result = await getAvailableModels(client)

      expect(result.status).toBe('unknown')
      expect(result.models).toBeInstanceOf(Set)
      expect(result.models.size).toBe(0)
    })

    test('returns empty Set when models.json has schema-mismatched content (provider without models key)', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify({ anthropic: { name: 'Anthropic' } }),
      )
      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const client = makeThrowingClient(new Error('network error'))
      const result = await getAvailableModels(client)

      expect(result.status).toBe('unknown')
      expect(result.models).toBeInstanceOf(Set)
      expect(result.models.size).toBe(0)
    })

    test('returns empty Set when models.json is unreadable (chmod 000)', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      const modelsPath = path.join(cacheDir, 'models.json')
      fs.writeFileSync(
        modelsPath,
        JSON.stringify({ anthropic: { models: {} } }),
      )
      fs.chmodSync(modelsPath, 0o000)
      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const client = makeThrowingClient(new Error('network error'))
      const result = await getAvailableModels(client)

      // Restore permissions for cleanup
      fs.chmodSync(modelsPath, 0o644)

      expect(result.status).toBe('unknown')
      expect(result.models).toBeInstanceOf(Set)
      expect(result.models.size).toBe(0)
    })
  })

  describe('error path: schema-mismatch warning', () => {
    test('emits scoped console.warn for schema-mismatched models.json', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify({ anthropic: { name: 'Anthropic' } }),
      )
      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const warnSpy = spyOn(console, 'warn')

      const client = makeThrowingClient(new Error('network error'))
      await getAvailableModels(client)

      const warnCalls = warnSpy.mock.calls
      const systematicWarn = warnCalls.find(
        (args) =>
          typeof args[0] === 'string' &&
          (args[0] as string).includes('[systematic]') &&
          (args[0] as string).includes('models.json'),
      )
      expect(systematicWarn).toBeDefined()

      warnSpy.mockRestore()
    })
  })

  describe('error path: wrapped future cache format', () => {
    test('treats { providers: { ... } } as schema-mismatched and returns status unknown', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify({
          providers: {
            anthropic: { models: {} },
          },
        }),
      )
      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const warnSpy = spyOn(console, 'warn')

      const client = makeThrowingClient(new Error('network error'))
      const result = await getAvailableModels(client)

      expect(result.status).toBe('unknown')
      expect(result.models).toBeInstanceOf(Set)
      expect(result.models.size).toBe(0)

      const warnCalls = warnSpy.mock.calls
      const systematicWarn = warnCalls.find(
        (args) =>
          typeof args[0] === 'string' &&
          (args[0] as string).includes('[systematic]') &&
          (args[0] as string).includes('models.json'),
      )
      expect(systematicWarn).toBeDefined()

      warnSpy.mockRestore()
    })
  })

  describe('timeout behavior', () => {
    test('resolves via cache fallback when API call exceeds apiTimeoutMs', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify({ anthropic: { models: { 'claude-sonnet-4-6': {} } } }),
      )
      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const client = makeHangingClient()
      const start = Date.now()
      const result = await getAvailableModels(client, { apiTimeoutMs: 50 })
      const elapsed = Date.now() - start

      // Should resolve quickly via cache, not hang
      expect(elapsed).toBeLessThan(500)
      expect(result.status).toBe('cache')
      expect(result.models.has('anthropic/claude-sonnet-4-6')).toBe(true)
    })

    test('returns status unknown when API times out and no cache exists', async () => {
      process.env.XDG_CACHE_HOME = path.join(testDir, 'nonexistent-cache')

      const client = makeHangingClient()
      const result = await getAvailableModels(client, { apiTimeoutMs: 50 })

      expect(result.status).toBe('unknown')
      expect(result.models.size).toBe(0)
    })

    // NOTE: Testing apiTimeoutMs: null with a hanging client would cause the
    // test to hang indefinitely. That behavior is intentional by design —
    // null disables the timeout entirely. Do not add such a test.
  })

  describe('oversized cache file', () => {
    test('skips cache file larger than 16MB and returns status unknown', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      const modelsPath = path.join(cacheDir, 'models.json')

      // Write minimal valid JSON then truncate to 17MB to simulate a pathological cache
      fs.writeFileSync(
        modelsPath,
        JSON.stringify({ anthropic: { models: {} } }),
      )
      fs.truncateSync(modelsPath, 17 * 1024 * 1024)

      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const warnSpy = spyOn(console, 'warn')

      const client = makeThrowingClient(new Error('network error'))
      const result = await getAvailableModels(client)

      expect(result.status).toBe('unknown')
      expect(result.models.size).toBe(0)

      // Should emit a warning about the oversized file
      const oversizeWarn = warnSpy.mock.calls.find(
        (args) =>
          typeof args[0] === 'string' &&
          (args[0] as string).includes('[systematic]') &&
          (args[0] as string).includes('bytes'),
      )
      expect(oversizeWarn).toBeDefined()

      warnSpy.mockRestore()
    })
  })

  describe('non-regular cache file', () => {
    test('reads through symlink to regular file (statSync follows symlinks)', async () => {
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })

      // Create a real file elsewhere and symlink it as models.json
      const realFile = path.join(testDir, 'real-models.json')
      fs.writeFileSync(
        realFile,
        JSON.stringify({ anthropic: { models: { 'claude-opus-4-7': {} } } }),
      )
      const modelsPath = path.join(cacheDir, 'models.json')
      fs.symlinkSync(realFile, modelsPath)

      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      const client = makeThrowingClient(new Error('network error'))
      const result = await getAvailableModels(client)

      // readModelsFromCache uses fs.statSync (follows symlinks), so a symlink
      // to a valid regular file is treated as a regular file and read normally.
      // The comment in production code mentions "symlinks" but the guard is
      // stat.isFile() which returns true for symlinks-to-files. Only true
      // non-regular files (devices, FIFOs, sockets) would be skipped.
      expect(result.status).toBe('cache')
      expect(result.models.has('anthropic/claude-opus-4-7')).toBe(true)
    })
  })

  describe('defensive: client without config.providers', () => {
    test('skips API and goes straight to cache when client.config is missing', async () => {
      // Integration tests and other callers may inject a partial client stub
      // that doesn't expose config.providers. The function should not crash;
      // it should treat this exactly like a transient API failure and fall
      // through to the cache.
      const cacheDir = path.join(testDir, 'cache', 'opencode')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(
        path.join(cacheDir, 'models.json'),
        JSON.stringify({
          anthropic: { models: { 'claude-opus-4-7': {} } },
        }),
      )
      process.env.XDG_CACHE_HOME = path.join(testDir, 'cache')

      // Cast through unknown: we're deliberately passing a stub without the
      // ClientConfigApi.providers method to exercise the defensive guard.
      const partialClient = { app: { log: async () => {} } } as unknown as {
        config: { providers: () => Promise<never> }
      }
      const result = await getAvailableModels(partialClient)

      expect(result.status).toBe('cache')
      expect(result.models.has('anthropic/claude-opus-4-7')).toBe(true)
    })

    test('returns unknown when client.config is missing and no cache exists', async () => {
      process.env.XDG_CACHE_HOME = path.join(testDir, 'nonexistent')

      const partialClient = {} as unknown as {
        config: { providers: () => Promise<never> }
      }
      const result = await getAvailableModels(partialClient)

      expect(result.status).toBe('unknown')
      expect(result.models.size).toBe(0)
    })
  })
})
