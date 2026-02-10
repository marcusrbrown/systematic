import fs from 'node:fs'

export interface ManifestSource {
  repo: string
  branch: string
  url: string
}

export interface ManifestDefinition {
  source: string
  upstream_path: string
  upstream_commit: string
  synced_at: string
  notes: string
}

export interface SyncManifest {
  $schema?: string
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

function isManifestDefinition(value: unknown): value is ManifestDefinition {
  if (!isRecord(value)) return false
  return (
    typeof value.source === 'string' &&
    typeof value.upstream_path === 'string' &&
    typeof value.upstream_commit === 'string' &&
    typeof value.synced_at === 'string' &&
    typeof value.notes === 'string'
  )
}

export function validateManifest(data: unknown): data is SyncManifest {
  if (!isRecord(data)) return false

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
