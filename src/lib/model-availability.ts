import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isRecord } from './validation.js'

interface ConnectedProvider {
  id: string
  models: Record<string, unknown>
}

interface ProvidersResponse {
  providers: ConnectedProvider[]
  default: Record<string, string>
}

interface ClientConfigApi {
  providers: () => Promise<
    | { data: ProvidersResponse; error: undefined }
    | { data: undefined; error: unknown }
  >
}

export interface OpencodeClientLike {
  config: ClientConfigApi
}

/**
 * Outcome of model availability discovery.
 *
 * - `api`: The OpenCode server's `/config/providers` endpoint responded with
 *   a connected-providers payload. `models` may be empty if no providers
 *   are authenticated; that is authoritative.
 * - `cache`: The API call failed (error envelope, thrown, or timed out) and
 *   the local `models.json` cache was readable. `models` reflects whatever
 *   OpenCode last wrote to disk.
 * - `unknown`: Both the API call and the cache fallback failed (cache
 *   missing, unreadable, corrupt, or schema-mismatched). Resolution should
 *   degrade gracefully — callers should treat `unknown` as a signal to
 *   skip source-default model pinning so users do not get agents pinned
 *   to inaccessible models. `models` is the empty set.
 */
export type DiscoveryStatus = 'api' | 'cache' | 'unknown'

export interface ModelAvailability {
  status: DiscoveryStatus
  /**
   * Set of `${providerId}/${modelId}` strings. Typed `ReadonlySet` because
   * callers must not mutate the returned collection — mutation would corrupt
   * future calls in the same process. Each `ModelAvailability` is a fresh
   * instance (see `emptyAvailability()`), so mutation via cast cannot
   * propagate, but the type makes intent explicit.
   */
  models: ReadonlySet<string>
}

/**
 * Returns a fresh `ModelAvailability` representing total discovery failure.
 * Factory pattern (not a shared singleton) guarantees each caller receives
 * an independent `models` set — a forced mutation via cast on one return
 * value cannot leak into any other caller's view.
 */
function emptyAvailability(): ModelAvailability {
  return { status: 'unknown', models: new Set<string>() }
}

const MAX_CACHE_FILE_BYTES = 16 * 1024 * 1024 // 16MB ceiling
const DEFAULT_API_TIMEOUT_MS = 1500
const MODELS_JSON_FILENAME = 'models.json'

function resolveCacheDir(): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim()
  const cacheBase =
    xdgCacheHome && path.isAbsolute(xdgCacheHome)
      ? xdgCacheHome
      : path.join(os.homedir(), '.cache')
  return path.join(cacheBase, 'opencode')
}

function fastHash(input: string): string {
  return createHash('sha1').update(input).digest('hex')
}

function isProviderRecord(
  value: unknown,
): value is Record<string, { models: Record<string, unknown> }> {
  if (!isRecord(value)) return false
  for (const entry of Object.values(value)) {
    if (!isRecord(entry)) return false
    if (!isRecord(entry.models)) return false
  }
  return true
}

function readModelsFromCache(filePath: string): Set<string> | null {
  // Open the file FIRST, then fstat the descriptor and read from it. This
  // avoids the TOCTOU race that `statSync(path)` + `readFileSync(path)`
  // creates — between the two calls the file at `path` can be replaced or
  // grown. By holding a single fd across both operations we read exactly
  // the bytes whose size we already checked.
  let fd: number
  try {
    fd = fs.openSync(filePath, 'r')
  } catch {
    return null
  }

  let raw: string
  try {
    let stat: fs.Stats
    try {
      stat = fs.fstatSync(fd)
    } catch {
      return null
    }

    // Skip non-regular files (devices, FIFOs, sockets) and oversized caches
    // before allocating a multi-megabyte buffer. Pathological cache files
    // must not OOM plugin startup.
    if (!stat.isFile()) return null
    if (stat.size === 0) return null
    if (stat.size > MAX_CACHE_FILE_BYTES) {
      console.warn(
        `[systematic] models.json at ${filePath} is ${stat.size} bytes (>${MAX_CACHE_FILE_BYTES}); treating as cache miss.`,
      )
      return null
    }

    const buffer = Buffer.alloc(stat.size)
    let bytesRead: number
    try {
      bytesRead = fs.readSync(fd, buffer, 0, stat.size, 0)
    } catch {
      return null
    }

    // If the file shrank between fstat and read (concurrent rewrite by
    // OpenCode), we got a partial buffer. Treat as cache miss rather than
    // attempting to parse truncated JSON.
    if (bytesRead !== stat.size) return null

    raw = buffer.toString('utf8')
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // Best-effort close; nothing actionable if it fails.
    }
  }

  if (raw.trim().length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!isProviderRecord(parsed)) {
    console.warn(
      `[systematic] models.json schema mismatch at ${filePath}; treating as cache miss. Upstream shape may have drifted.`,
    )
    return null
  }

  const result = new Set<string>()
  for (const [providerId, providerData] of Object.entries(parsed)) {
    for (const modelId of Object.keys(providerData.models)) {
      result.add(`${providerId}/${modelId}`)
    }
  }
  return result
}

function readFallbackCache(): ModelAvailability {
  const cacheDir = resolveCacheDir()
  const openCodeModelsUrl = process.env.OPENCODE_MODELS_URL?.trim()

  // When OPENCODE_MODELS_URL is set, OpenCode writes the cache to
  // `models-<sha1-hex>.json` where the hash is `Hash.fast(url)` — verified
  // against `.slim/clonedeps/repos/anomalyco__opencode/packages/core/src/util/hash.ts`.
  // Match that exactly rather than wildcard-globbing `models-*.json`, which
  // would let an attacker (or an old stale file from a previous URL) override
  // the legitimate cache.
  if (openCodeModelsUrl) {
    const urlDerivedPath = path.join(
      cacheDir,
      `models-${fastHash(openCodeModelsUrl)}.json`,
    )
    const urlResult = readModelsFromCache(urlDerivedPath)
    if (urlResult !== null) {
      return { status: 'cache', models: urlResult }
    }
    // When OPENCODE_MODELS_URL is set, the URL-derived cache file is the
    // only authoritative source for this registry. Do not fall through to
    // the default models.json — that file belongs to a different registry
    // trust domain and could cause Systematic to pin source defaults from
    // unrelated availability data.
    return emptyAvailability()
  }

  const defaultPath = path.join(cacheDir, MODELS_JSON_FILENAME)
  const defaultResult = readModelsFromCache(defaultPath)
  if (defaultResult !== null) {
    return { status: 'cache', models: defaultResult }
  }

  return emptyAvailability()
}

function buildSetFromProviders(providers: ConnectedProvider[]): Set<string> {
  const result = new Set<string>()
  for (const provider of providers) {
    for (const modelId of Object.keys(provider.models)) {
      result.add(`${provider.id}/${modelId}`)
    }
  }
  return result
}

interface AvailabilityOptions {
  /**
   * Maximum time to wait for `client.config.providers()` before falling
   * back to the local cache. Defaults to 1500ms — a startup-budget value
   * that prevents a slow/half-open OpenCode server from holding the plugin
   * indefinitely.
   *
   * Set to `null` to disable the timeout entirely (not recommended).
   */
  apiTimeoutMs?: number | null
}

/**
 * Discover the set of `provider/model` keys the OpenCode server considers
 * connected (or, on API failure, the set last written to the on-disk
 * `models.json` cache).
 *
 * The returned `status` lets callers distinguish three discovery outcomes:
 * - `api`: live answer; safe to pin source-default models against it
 * - `cache`: degraded but informed; the cached `provider/model` keys are
 *   plausibly still authoritative
 * - `unknown`: both the API and the cache failed; callers should fall back
 *   to OpenCode's parent-model inheritance rather than pinning a source
 *   default the user may not have access to
 *
 * The API call is bounded by `apiTimeoutMs` (default 1500ms). On timeout,
 * thrown error, error-envelope response, or undefined data, the cache
 * fallback runs. The function never rejects.
 */
export async function getAvailableModels(
  client: OpencodeClientLike,
  options: AvailabilityOptions = {},
): Promise<ModelAvailability> {
  const timeoutMs =
    options.apiTimeoutMs === undefined
      ? DEFAULT_API_TIMEOUT_MS
      : options.apiTimeoutMs

  // Defensive against partial/test client shapes: if config.providers isn't a
  // callable function, skip the API entirely and go straight to the cache.
  // This keeps the function robust against any plugin-input variation and
  // matches the documented contract of "never rejects, always returns a
  // ModelAvailability envelope."
  if (typeof client.config?.providers !== 'function') {
    return readFallbackCache()
  }

  const apiCall = client.config.providers()

  let response: Awaited<ReturnType<ClientConfigApi['providers']>>
  try {
    if (timeoutMs === null) {
      response = await apiCall
    } else {
      const TIMEOUT_SENTINEL = Symbol('timeout')
      const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        const timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs)
        // Avoid keeping the event loop alive past plugin init.
        timer.unref?.()
      })
      const raced = await Promise.race([apiCall, timeoutPromise])
      if (raced === TIMEOUT_SENTINEL) {
        console.warn(
          `[systematic] client.config.providers() exceeded ${timeoutMs}ms; falling back to models.json cache.`,
        )
        return readFallbackCache()
      }
      response = raced
    }
  } catch {
    return readFallbackCache()
  }

  if (response.error !== undefined || response.data === undefined) {
    return readFallbackCache()
  }

  const models = buildSetFromProviders(response.data.providers)

  // Empty discovery collapses to `'unknown'`. An authoritatively-empty API
  // response is operationally identical to total discovery failure — we cannot
  // point bundled agents at any model the user can call. Downstream consumers
  // gate on `status !== 'unknown'`, so returning `'unknown'` here funnels the
  // empty case through the same skip-source-default-pinning path that real
  // discovery failures take.
  //
  // Empirical anchor: `.slim/clonedeps/repos/anomalyco__opencode/packages/opencode/src/provider/provider.ts:1115-1336`
  // shows `mergeProvider` only adds a provider to `state.providers` when one
  // of four signals fires (config block, env var, auth.json type:"api", or
  // plugin auth.loader). Logged-out, unconfigured, and unauthenticated
  // providers all converge to the same SDK shape — an empty `providers`
  // array. The threshold checks `models.size === 0` after
  // `buildSetFromProviders`, which catches all variants regardless of upstream
  // SDK shape (including non-empty `providers` arrays where the provider
  // entries themselves have no usable models).
  if (models.size === 0) {
    return emptyAvailability()
  }

  return {
    status: 'api',
    models,
  }
}
