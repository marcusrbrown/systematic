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

function resolveCacheDir(): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim()
  const cacheBase =
    xdgCacheHome && path.isAbsolute(xdgCacheHome)
      ? xdgCacheHome
      : path.join(os.homedir(), '.cache')
  return path.join(cacheBase, 'opencode')
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

function findUrlDerivedCacheFile(cacheDir: string): string | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(cacheDir)
  } catch {
    return null
  }

  const candidates = entries
    .filter((name) => /^models-.+\.json$/.test(name))
    .map((name) => {
      const fullPath = path.join(cacheDir, name)
      try {
        const stat = fs.statSync(fullPath)
        return { fullPath, mtime: stat.mtimeMs }
      } catch {
        return null
      }
    })
    .filter(
      (entry): entry is { fullPath: string; mtime: number } => entry !== null,
    )
    .sort((a, b) => b.mtime - a.mtime)

  return candidates.length > 0 ? candidates[0].fullPath : null
}

function readFallbackCache(): Set<string> {
  const cacheDir = resolveCacheDir()
  const openCodeModelsUrl = process.env.OPENCODE_MODELS_URL?.trim()

  if (openCodeModelsUrl) {
    const urlDerivedPath = findUrlDerivedCacheFile(cacheDir)
    if (urlDerivedPath !== null) {
      const result = readModelsFromCache(urlDerivedPath)
      if (result !== null) return result
    }
    // Fall through to models.json if no URL-derived file parsed successfully
  }

  const defaultPath = path.join(cacheDir, 'models.json')
  const result = readModelsFromCache(defaultPath)
  return result ?? new Set<string>()
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

export async function getAvailableModels(
  client: OpencodeClientLike,
): Promise<Set<string>> {
  try {
    const response = await client.config.providers()

    if (response.error !== undefined || response.data === undefined) {
      return readFallbackCache()
    }

    return buildSetFromProviders(response.data.providers)
  } catch {
    return readFallbackCache()
  }
}
