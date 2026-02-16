import fs from 'node:fs'

export interface ManifestSource {
  repo: string
  branch: string
  url: string
}

export interface ManifestRewrite {
  field: string
  reason: string
  original?: string
}

export interface ManualOverride {
  field: string
  reason: string
  original?: string
  overridden_at: string
}

export interface ManifestDefinition {
  source: string
  upstream_path: string
  upstream_commit: string
  synced_at: string
  notes: string
  files?: string[]
  upstream_content_hash?: string
  rewrites?: ManifestRewrite[]
  manual_overrides?: ManualOverride[]
}

export interface SyncManifest {
  $schema?: string
  converter_version?: number
  sources: Record<string, ManifestSource>
  definitions: Record<string, ManifestDefinition>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isManifestSource(value: unknown): value is ManifestSource {
  if (!isRecord(value)) return false
  return (
    typeof value.repo === 'string' &&
    typeof value.branch === 'string' &&
    typeof value.url === 'string'
  )
}

function isManifestRewrite(value: unknown): value is ManifestRewrite {
  if (!isRecord(value)) return false
  return typeof value.field === 'string' && typeof value.reason === 'string'
}

function isManualOverride(value: unknown): value is ManualOverride {
  if (!isRecord(value)) return false
  return (
    typeof value.field === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.overridden_at === 'string'
  )
}

function isRewriteArray(value: unknown): value is ManifestRewrite[] {
  return Array.isArray(value) && value.every(isManifestRewrite)
}

function isOverrideArray(value: unknown): value is ManualOverride[] {
  return Array.isArray(value) && value.every(isManualOverride)
}

function isManifestDefinition(value: unknown): value is ManifestDefinition {
  if (!isRecord(value)) return false
  const hasRequired =
    typeof value.source === 'string' &&
    typeof value.upstream_path === 'string' &&
    typeof value.upstream_commit === 'string' &&
    typeof value.synced_at === 'string' &&
    typeof value.notes === 'string'
  if (!hasRequired) return false

  if (
    value.upstream_content_hash !== undefined &&
    typeof value.upstream_content_hash !== 'string'
  )
    return false
  if (value.files !== undefined) {
    if (!Array.isArray(value.files)) return false
    if (!value.files.every((file) => typeof file === 'string')) return false
  }
  if (value.rewrites !== undefined && !isRewriteArray(value.rewrites))
    return false
  if (
    value.manual_overrides !== undefined &&
    !isOverrideArray(value.manual_overrides)
  )
    return false

  return true
}

export function validateManifest(data: unknown): data is SyncManifest {
  if (!isRecord(data)) return false

  if (
    data.converter_version !== undefined &&
    typeof data.converter_version !== 'number'
  )
    return false

  if (!isRecord(data.sources)) return false
  for (const source of Object.values(data.sources)) {
    if (!isManifestSource(source)) return false
  }

  if (!isRecord(data.definitions)) return false
  for (const def of Object.values(data.definitions)) {
    if (!isManifestDefinition(def)) return false
  }

  return true
}

export function readManifest(filePath: string): SyncManifest | null {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn(`sync-manifest.json: invalid JSON at ${filePath}`)
    return null
  }

  if (!validateManifest(parsed)) {
    console.warn(`sync-manifest.json: schema validation failed at ${filePath}`)
    return null
  }

  return parsed
}

export function writeManifest(filePath: string, manifest: SyncManifest): void {
  const content = `${JSON.stringify(manifest, null, 2)}\n`
  fs.writeFileSync(filePath, content, 'utf8')
}

export function findStaleEntries(
  manifest: SyncManifest,
  existingPaths: string[],
): string[] {
  return Object.keys(manifest.definitions).filter(
    (key) => !existingPaths.includes(key),
  )
}

export function listDefinitionsBySource(
  manifest: SyncManifest,
  source: string,
): string[] {
  return Object.keys(manifest.definitions)
    .filter((key) => manifest.definitions[key]?.source === source)
    .sort()
}

export function getUpstreamHashes(
  manifest: SyncManifest,
  source: string,
): Record<string, string> {
  const entries = listDefinitionsBySource(manifest, source)
  return Object.fromEntries(
    entries.map((key) => [
      key,
      manifest.definitions[key]?.upstream_content_hash ?? '',
    ]),
  )
}
