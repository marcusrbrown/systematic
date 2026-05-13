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
  models: Set<string>
}

const EMPTY_AVAILABILITY: ModelAvailability = {
  status: 'unknown',
  models: new Set<string>(),
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
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return null
  }

  // Skip non-regular files (symlinks, devices) and oversized caches before
  // allocating a multi-megabyte string. Pathological cache files must not
  // OOM plugin startup.
  if (!stat.isFile()) return null
  if (stat.size === 0) return null
  if (stat.size > MAX_CACHE_FILE_BYTES) {
    console.warn(
      `[systematic] models.json at ${filePath} is ${stat.size} bytes (>${MAX_CACHE_FILE_BYTES}); treating as cache miss.`,
    )
    return null
  }

  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
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
    // Fall through to models.json when the URL-derived cache is absent
  }

  const defaultPath = path.join(cacheDir, MODELS_JSON_FILENAME)
  const defaultResult = readModelsFromCache(defaultPath)
  if (defaultResult !== null) {
    return { status: 'cache', models: defaultResult }
  }

  return EMPTY_AVAILABILITY
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

  return {
    status: 'api',
    models: buildSetFromProviders(response.data.providers),
  }
}
