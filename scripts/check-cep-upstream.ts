#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { CONVERTER_VERSION } from '../src/lib/converter.js'
import { readManifest, type SyncManifest } from '../src/lib/manifest.js'

export interface CheckSummary {
  hashChanges: string[]
  newUpstream: string[]
  deletions: string[]
  skipped: string[]
  converterVersionChanged: boolean
}

export interface CheckInputs {
  manifest: SyncManifest
  upstreamDefinitionKeys: string[]
  upstreamContents: Record<string, string>
  converterVersion: number
}

export interface FetchResult {
  definitionKeys: string[]
  contents: Record<string, string>
  hadError: boolean
}

const MANIFEST_PATH = 'sync-manifest.json'

const hashContent = (content: string): string =>
  createHash('sha256').update(content).digest('hex')

const joinUpstreamPath = (base: string, file: string): string =>
  `${base.replace(/\/$/, '')}/${file}`

export const toDefinitionKey = (path: string): string | null => {
  const prefix = 'plugins/compound-engineering/'
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

const hasWildcardOverride = (manifest: SyncManifest, key: string): boolean => {
  const overrides = manifest.definitions[key]?.manual_overrides ?? []
  return overrides.some((override) => override.field === '*')
}

const computeSkillHash = (
  basePath: string,
  files: string[],
  upstreamContents: Record<string, string>,
): string => {
  const ordered = [...files].sort()
  const combined = ordered
    .map((file) => upstreamContents[joinUpstreamPath(basePath, file)] ?? '')
    .join('')
  return hashContent(combined)
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
  const treeResponse = await fetchFn(treeUrl)
  if (!treeResponse.ok) {
    return { definitionKeys: [], contents: {}, hadError: true }
  }
  const treeRaw = await treeResponse.text()
  const treePaths = parseTreePaths(treeRaw)
  for (const path of treePaths) {
    const key = toDefinitionKey(path)
    if (key != null) definitionKeys.add(key)
  }

  for (const path of paths) {
    const contentUrl = `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`
    const response = await fetchFn(contentUrl)
    if (!response.ok) {
      hadError = true
      continue
    }
    const payload: unknown = await response.json()
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
    hadError,
  }
}

export const computeCheckSummary = ({
  manifest,
  upstreamDefinitionKeys,
  upstreamContents,
  converterVersion,
}: CheckInputs): CheckSummary => {
  const hashChanges: string[] = []
  const newUpstream: string[] = []
  const deletions: string[] = []
  const skipped: string[] = []

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
    const upstreamPath = entry.upstream_path

    const currentHash = entry.upstream_content_hash ?? ''
    const nextHash = entry.files?.length
      ? computeSkillHash(upstreamPath, entry.files, upstreamContents)
      : hashContent(upstreamContents[upstreamPath] ?? '')

    if (nextHash !== currentHash) {
      hashChanges.push(key)
    }
  }

  return {
    hashChanges,
    newUpstream,
    deletions,
    skipped,
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
  if (hadError) return 2
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
      converterVersion: CONVERTER_VERSION,
    })

    console.log(JSON.stringify(summary, null, 2))
    process.exit(getExitCode(summary, fetchResult.hadError))
  }

  run().catch(() => {
    process.exit(2)
  })
}

if (import.meta.main) {
  main()
}
