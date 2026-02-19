#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { CONVERTER_VERSION } from '../src/lib/converter.js'
import { readManifest, type SyncManifest } from '../src/lib/manifest.js'

export interface CheckSummary {
  hashChanges: string[]
  newUpstream: string[]
  newUpstreamFiles: Record<string, string[]>
  deletions: string[]
  skipped: string[]
  converterVersionChanged: boolean
  errors: string[]
}

export interface CheckInputs {
  manifest: SyncManifest
  upstreamDefinitionKeys: string[]
  upstreamContents: Record<string, string>
  treePaths: string[]
  converterVersion: number
}

export interface FetchResult {
  definitionKeys: string[]
  contents: Record<string, string>
  treePaths: string[]
  hadError: boolean
}

const MANIFEST_PATH = 'sync-manifest.json'

const hashContent = (content: string): string =>
  createHash('sha256').update(content).digest('hex')

const joinUpstreamPath = (base: string, file: string): string =>
  `${base.replace(/\/$/, '')}/${file}`

const CEP_PREFIX = 'plugins/compound-engineering/'

export const toDefinitionKey = (path: string): string | null => {
  const prefix = CEP_PREFIX
  if (!path.startsWith(prefix)) return null

  const rest = path.slice(prefix.length)
  if (rest.startsWith('agents/') && rest.endsWith('.md')) {
    return rest.replace(/\.md$/, '')
  }

  if (rest.startsWith('commands/') && rest.endsWith('.md')) {
    return rest.replace(/\.md$/, '')
  }

  if (rest.startsWith('skills/')) {
    const parts = rest.split('/')
    if (parts.length === 2 && parts[1].endsWith('.md')) {
      return `${parts[0]}/${parts[1].replace(/\.md$/, '')}`
    }
    if (parts.length >= 3 && parts[2] === 'SKILL.md') {
      return `${parts[0]}/${parts[1]}`
    }
  }

  return null
}

const collectSkillFiles = (treePaths: string[], key: string): string[] => {
  const dirPrefix = `${CEP_PREFIX}${key}/`
  const files: string[] = []
  for (const path of treePaths) {
    if (path.startsWith(dirPrefix)) {
      files.push(path.slice(dirPrefix.length))
    }
  }
  return files.sort()
}

/**
 * Given the full tree paths and a set of new definition keys, collect all files
 * belonging to each new definition. For skills this means all files under the
 * skill directory; for agents/commands it's the single .md file.
 */
export const collectNewUpstreamFiles = (
  treePaths: string[],
  newKeys: string[],
): Record<string, string[]> => {
  const result: Record<string, string[]> = {}
  const treeSet = new Set(treePaths)
  for (const key of newKeys) {
    if (key.startsWith('skills/')) {
      const files = collectSkillFiles(treePaths, key)
      if (files.length > 0) {
        result[key] = files
      }
    } else {
      const filePath = `${CEP_PREFIX}${key}.md`
      if (treeSet.has(filePath)) {
        result[key] = [`${key.split('/').pop()}.md`]
      }
    }
  }
  return result
}

const hasWildcardOverride = (manifest: SyncManifest, key: string): boolean => {
  const overrides = manifest.definitions[key]?.manual_overrides ?? []
  return overrides.some((override) => override.field === '*')
}

const computeSkillHash = (
  basePath: string,
  files: string[],
  upstreamContents: Record<string, string>,
  errors: string[],
): string | null => {
  const ordered = [...files].sort()
  let hasMissing = false
  const parts: string[] = []
  for (const file of ordered) {
    const path = joinUpstreamPath(basePath, file)
    const content = upstreamContents[path]
    if (content == null) {
      errors.push(
        `Missing upstream content for sub-file (may be a transient fetch failure or the file was removed upstream): ${path}`,
      )
      hasMissing = true
      continue
    }
    parts.push(content)
  }
  if (hasMissing) return null
  return hashContent(parts.join('\0'))
}

const recordMissingContent = (
  upstreamContents: Record<string, string>,
  path: string,
  errors: string[],
): boolean => {
  if (path in upstreamContents) return false
  errors.push(
    `Missing upstream content for sub-file (may be a transient fetch failure or the file was removed upstream): ${path}`,
  )
  return true
}

const computeEntryHash = (
  entry: SyncManifest['definitions'][string],
  upstreamContents: Record<string, string>,
  errors: string[],
): string | null => {
  const upstreamPath = entry.upstream_path
  if (!entry.files?.length) {
    if (recordMissingContent(upstreamContents, upstreamPath, errors)) {
      return null
    }
    return hashContent(upstreamContents[upstreamPath] ?? '')
  }

  return computeSkillHash(upstreamPath, entry.files, upstreamContents, errors)
}

export const getRequiredUpstreamContentPaths = ({
  manifest,
  upstreamDefinitionKeys,
}: {
  manifest: SyncManifest
  upstreamDefinitionKeys: string[]
}): string[] => {
  const paths = new Set<string>()
  for (const key of upstreamDefinitionKeys) {
    const entry = manifest.definitions[key]
    if (!entry) continue
    if (entry.files && entry.files.length > 0) {
      for (const file of entry.files) {
        paths.add(joinUpstreamPath(entry.upstream_path, file))
      }
    } else {
      paths.add(entry.upstream_path)
    }
  }
  return Array.from(paths).sort()
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const parseTreePaths = (raw: string): string[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  if (!isObject(parsed)) return []
  const tree = parsed.tree
  if (!Array.isArray(tree)) return []

  const results: string[] = []
  for (const item of tree) {
    if (!isObject(item)) continue
    if (item.type !== 'blob') continue
    if (!isString(item.path)) continue
    results.push(item.path)
  }
  return results
}

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 10000

const isRetryStatus = (status: number): boolean =>
  status === 403 || status === 429

const readRetryAfterSeconds = (response: Response): number | null => {
  const value = response.headers.get('retry-after')
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

const computeDelayMs = (attempt: number, response?: Response): number => {
  const retryAfter = response ? readRetryAfterSeconds(response) : null
  if (retryAfter != null) {
    return Math.min(retryAfter * 1000, MAX_DELAY_MS)
  }
  return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS)
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const fetchWithRetry = async (
  url: string,
  fetchFn: (url: string) => Promise<Response>,
): Promise<{ response: Response | null; hadError: boolean }> => {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetchFn(url)
    if (response.ok) return { response, hadError: false }
    if (!isRetryStatus(response.status)) {
      return { response, hadError: true }
    }
    if (attempt === MAX_RETRIES) {
      return { response, hadError: true }
    }
    await sleep(computeDelayMs(attempt, response))
  }

  return { response: null, hadError: true }
}

export const fetchUpstreamData = async (
  repo: string,
  branch: string,
  paths: string[],
  fetchFn: (url: string) => Promise<Response>,
): Promise<FetchResult> => {
  let hadError = false
  const definitionKeys = new Set<string>()
  const contents: Record<string, string> = {}

  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`
  const treeResult = await fetchWithRetry(treeUrl, fetchFn)
  if (!treeResult.response || !treeResult.response.ok) {
    return { definitionKeys: [], contents: {}, treePaths: [], hadError: true }
  }
  const treeRaw = await treeResult.response.text()
  const treePaths = parseTreePaths(treeRaw)
  for (const path of treePaths) {
    const key = toDefinitionKey(path)
    if (key != null) definitionKeys.add(key)
  }

  for (const path of paths) {
    const contentUrl = `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`
    const result = await fetchWithRetry(contentUrl, fetchFn)
    if (!result.response || !result.response.ok) {
      if (!result.response || result.response.status !== 404) {
        hadError = true
      }
      continue
    }
    const payload: unknown = await result.response.json()
    if (!isObject(payload) || !isString(payload.content)) {
      hadError = true
      continue
    }
    const decoded = Buffer.from(payload.content, 'base64').toString('utf8')
    contents[path] = decoded
  }

  return {
    definitionKeys: Array.from(definitionKeys).sort(),
    contents,
    treePaths,
    hadError,
  }
}

export const computeCheckSummary = ({
  manifest,
  upstreamDefinitionKeys,
  upstreamContents,
  treePaths,
  converterVersion,
}: CheckInputs): CheckSummary => {
  const hashChanges: string[] = []
  const newUpstream: string[] = []
  const deletions: string[] = []
  const skipped: string[] = []
  const errors: string[] = []

  const manifestKeys = Object.keys(manifest.definitions)
  const upstreamSet = new Set(upstreamDefinitionKeys)

  for (const key of upstreamDefinitionKeys) {
    if (!manifest.definitions[key]) {
      newUpstream.push(key)
    }
  }

  for (const key of manifestKeys) {
    if (!upstreamSet.has(key)) {
      deletions.push(key)
      continue
    }

    if (hasWildcardOverride(manifest, key)) {
      skipped.push(key)
      continue
    }

    const entry = manifest.definitions[key]
    const currentHash = entry.upstream_content_hash ?? ''
    const nextHash = computeEntryHash(entry, upstreamContents, errors)
    if (!nextHash) {
      continue
    }

    if (nextHash !== currentHash) {
      hashChanges.push(key)
    }
  }

  const newUpstreamFiles = collectNewUpstreamFiles(treePaths, newUpstream)

  return {
    hashChanges,
    newUpstream,
    newUpstreamFiles,
    deletions,
    skipped,
    errors,
    converterVersionChanged:
      manifest.converter_version !== undefined &&
      manifest.converter_version !== converterVersion,
  }
}

export const hasChanges = (summary: CheckSummary): boolean => {
  return (
    summary.hashChanges.length > 0 ||
    summary.newUpstream.length > 0 ||
    summary.deletions.length > 0 ||
    summary.converterVersionChanged
  )
}

export const getExitCode = (
  summary: CheckSummary,
  hadError: boolean,
): number => {
  if (hadError || summary.errors.length > 0) return 2
  return hasChanges(summary) ? 1 : 0
}

const main = (): void => {
  const manifest = readManifest(MANIFEST_PATH)
  if (!manifest) {
    process.exit(2)
  }

  const source = manifest.sources.cep
  if (!source) {
    process.exit(2)
  }

  const run = async (): Promise<void> => {
    const requiredPaths = getRequiredUpstreamContentPaths({
      manifest,
      upstreamDefinitionKeys: Object.keys(manifest.definitions),
    })
    const fetchResult = await fetchUpstreamData(
      source.repo,
      source.branch,
      requiredPaths,
      fetch,
    )

    const summary = computeCheckSummary({
      manifest,
      upstreamDefinitionKeys: fetchResult.definitionKeys,
      upstreamContents: fetchResult.contents,
      treePaths: fetchResult.treePaths,
      converterVersion: CONVERTER_VERSION,
    })

    console.log(JSON.stringify(summary, null, 2))
    process.exit(getExitCode(summary, fetchResult.hadError))
  }

  run().catch((error: unknown) => {
    console.error('check-cep-upstream failed:', error)
    process.exit(2)
  })
}

if (import.meta.main) {
  main()
}
