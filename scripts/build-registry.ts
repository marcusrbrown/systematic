#!/usr/bin/env bun
import { execSync } from 'node:child_process'
/**
 * Build OCX Registry
 *
 * Reads registry/registry.jsonc, validates all referenced files exist,
 * and produces dist/registry/ output following OCX Registry Protocol v1.
 *
 * Usage:
 *   bun scripts/build-registry.ts                    # Full build
 *   bun scripts/build-registry.ts --validate-only    # Validate without output
 *   bun scripts/build-registry.ts --version 1.2.3    # Inject specific version
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseJsonc } from 'jsonc-parser'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')
const REGISTRY_SOURCE = path.join(PROJECT_ROOT, 'registry/registry.jsonc')
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'dist/registry')

const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/

interface RegistryFile {
  path: string
  target: string
}

interface RegistryComponent {
  name: string
  type: string
  version: string
  description?: string
  files?: RegistryFile[]
  dependencies?: string[]
  opencode?: Record<string, unknown>
}

interface RegistrySource {
  $schema?: string
  name: string
  namespace: string
  version: string
  author?: string
  components: RegistryComponent[]
}

interface PackumentFile {
  path: string
  target: string
  integrity: string
}

interface PackumentVersion {
  name: string
  type: string
  version: string
  description?: string
  files?: PackumentFile[]
  dependencies?: string[]
  opencode?: Record<string, unknown>
}

interface Packument {
  name: string
  'dist-tags': { latest: string }
  versions: Record<string, PackumentVersion>
}

interface IndexComponent {
  name: string
  type: string
  version: string
  description?: string
}

interface RegistryIndex {
  name: string
  namespace: string
  version: string
  components: IndexComponent[]
}

function parseArgs(): { version: string | null; validateOnly: boolean } {
  const args = process.argv.slice(2)
  let version: string | null = null
  let validateOnly = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--validate-only') {
      validateOnly = true
    } else if (arg === '--version') {
      const next = args[i + 1]
      if (next == null || next.startsWith('--')) {
        console.error('Error: --version requires a value')
        process.exit(1)
      }
      version = next
      i++
    } else if (arg.startsWith('--version=')) {
      version = arg.slice('--version='.length)
    }
  }

  return { version, validateOnly }
}

function resolveVersion(explicit: string | null): string {
  if (explicit != null) {
    if (!SEMVER_REGEX.test(explicit)) {
      console.error(
        `Error: Invalid version format "${explicit}". Must be valid semver (e.g., 1.2.3)`,
      )
      process.exit(1)
    }
    return explicit
  }

  try {
    const tag = execSync('git describe --tags --abbrev=0', {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
    }).trim()
    if (tag.length > 0) {
      return tag
    }
  } catch {
    // git tag failed, fall through to package.json
  }

  const pkgPath = path.join(PROJECT_ROOT, 'package.json')
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      version?: string
    }
    const v = pkg.version
    if (
      typeof v === 'string' &&
      v.length > 0 &&
      !v.includes('semantic-release')
    ) {
      return v
    }
  } catch {}

  return '0.0.0-dev'
}

function loadRegistrySource(): RegistrySource {
  if (!fs.existsSync(REGISTRY_SOURCE)) {
    console.error(`Error: Registry source not found: ${REGISTRY_SOURCE}`)
    process.exit(1)
  }

  const raw = fs.readFileSync(REGISTRY_SOURCE, 'utf-8')
  const parsed = parseJsonc(raw) as RegistrySource | undefined

  if (parsed == null || !Array.isArray(parsed.components)) {
    console.error('Error: Invalid registry source — missing components array')
    process.exit(1)
  }

  return parsed
}

/**
 * Maps a component's file entry to its actual disk location.
 * Skills use paths relative to skills/{name}/, agents/commands use project-root-relative paths.
 */
function resolveComponentFilePath(
  component: RegistryComponent,
  file: RegistryFile,
): string {
  const type = component.type

  if (type === 'ocx:skill') {
    return path.join(PROJECT_ROOT, 'skills', component.name, file.path)
  }

  if (type === 'ocx:agent') {
    return path.join(PROJECT_ROOT, file.path)
  }

  if (type === 'ocx:command') {
    return path.join(PROJECT_ROOT, file.path)
  }

  return path.join(PROJECT_ROOT, 'registry/files', file.path)
}

function validateRegistry(source: RegistrySource): string[] {
  const errors: string[] = []
  const componentNames = new Set<string>()

  for (const component of source.components) {
    if (componentNames.has(component.name)) {
      errors.push(`Duplicate component name: "${component.name}"`)
    }
    componentNames.add(component.name)

    if (component.type === 'ocx:skill') {
      validateSkillComponent(component, errors)
    } else if (component.type === 'ocx:agent') {
      validateFileComponent(component, errors)
    } else if (component.type === 'ocx:command') {
      validateFileComponent(component, errors)
    } else if (component.type === 'ocx:bundle') {
      validateBundleComponent(component, source, errors)
    } else if (component.type === 'ocx:plugin') {
    } else {
      errors.push(
        `[${component.name}] Unknown component type: "${component.type}"`,
      )
    }
  }

  return errors
}

function validateSkillComponent(
  component: RegistryComponent,
  errors: string[],
): void {
  const prefix = `[${component.name}]`

  if (!Array.isArray(component.files) || component.files.length === 0) {
    errors.push(`${prefix} Skill component must have at least one file`)
    return
  }

  const hasSkillMd = component.files.some((f) => f.path === 'SKILL.md')
  if (!hasSkillMd) {
    errors.push(`${prefix} Skill component missing SKILL.md`)
  }

  for (const file of component.files) {
    const diskPath = resolveComponentFilePath(component, file)
    if (!fs.existsSync(diskPath)) {
      errors.push(
        `${prefix} File not found: ${file.path} (expected at ${diskPath})`,
      )
    }
  }

  const skillDir = path.join(PROJECT_ROOT, 'skills', component.name)
  if (fs.existsSync(skillDir)) {
    const diskFiles = walkFiles(skillDir)
    const declaredPaths = new Set(component.files.map((f) => f.path))

    for (const diskFile of diskFiles) {
      const rel = path.relative(skillDir, diskFile)
      if (!declaredPaths.has(rel)) {
        errors.push(`${prefix} Unlisted file in skill directory: ${rel}`)
      }
    }
  }
}

function validateFileComponent(
  component: RegistryComponent,
  errors: string[],
): void {
  const prefix = `[${component.name}]`

  if (!Array.isArray(component.files) || component.files.length === 0) {
    errors.push(`${prefix} Component must have at least one file`)
    return
  }

  for (const file of component.files) {
    if (!file.path.endsWith('.md')) {
      errors.push(`${prefix} File should be .md: ${file.path}`)
    }

    const diskPath = resolveComponentFilePath(component, file)
    if (!fs.existsSync(diskPath)) {
      errors.push(
        `${prefix} File not found: ${file.path} (expected at ${diskPath})`,
      )
    }
  }
}

function validateBundleComponent(
  component: RegistryComponent,
  source: RegistrySource,
  errors: string[],
): void {
  const prefix = `[${component.name}]`

  if (
    !Array.isArray(component.dependencies) ||
    component.dependencies.length === 0
  ) {
    errors.push(`${prefix} Bundle must have at least one dependency`)
    return
  }

  const allNames = new Set(source.components.map((c) => c.name))
  for (const dep of component.dependencies) {
    if (!allNames.has(dep)) {
      errors.push(`${prefix} Bundle references unknown component: "${dep}"`)
    }
  }
}

/** Recursively collects all content files, excluding .DS_Store */
function walkFiles(dir: string): string[] {
  const results: string[] = []

  if (!fs.existsSync(dir)) return results

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue

    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath))
    } else {
      results.push(fullPath)
    }
  }

  return results
}

/** SHA-256 integrity: sha256-{base64(digest)} per OCX spec */
function computeIntegrity(content: Buffer): string {
  const hash = createHash('sha256').update(content).digest('base64')
  return `sha256-${hash}`
}

function buildRegistry(source: RegistrySource, version: string): void {
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
  }
  fs.mkdirSync(path.join(OUTPUT_DIR, 'components'), { recursive: true })

  const indexComponents: IndexComponent[] = []

  for (const component of source.components) {
    const entry: IndexComponent = {
      name: component.name,
      type: component.type,
      version,
    }
    if (component.description != null) {
      entry.description = component.description
    }
    indexComponents.push(entry)

    if (Array.isArray(component.files) && component.files.length > 0) {
      buildPackument(component, version)
    } else if (component.type === 'ocx:bundle') {
      buildBundlePackument(component, version)
    } else if (component.type === 'ocx:plugin') {
      buildPluginPackument(component, version)
    }
  }

  const index: RegistryIndex = {
    name: source.name,
    namespace: source.namespace,
    version,
    components: indexComponents,
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'index.json'),
    JSON.stringify(index, null, 2) + '\n',
  )
}

function buildPackument(component: RegistryComponent, version: string): void {
  const files = component.files ?? []
  const packumentFiles: PackumentFile[] = []

  for (const file of files) {
    const sourcePath = resolveComponentFilePath(component, file)
    let content: Buffer
    try {
      content = fs.readFileSync(sourcePath)
    } catch {
      continue
    }
    const integrity = computeIntegrity(content)

    packumentFiles.push({
      path: file.path,
      target: file.target,
      integrity,
    })

    const outputPath = path.join(
      OUTPUT_DIR,
      'components',
      component.name,
      file.path,
    )
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, content)
  }

  const versionData: PackumentVersion = {
    name: component.name,
    type: component.type,
    version,
  }
  if (component.description != null) {
    versionData.description = component.description
  }
  versionData.files = packumentFiles

  const packument: Packument = {
    name: component.name,
    'dist-tags': { latest: version },
    versions: { [version]: versionData },
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'components', `${component.name}.json`),
    JSON.stringify(packument, null, 2) + '\n',
  )
}

function buildBundlePackument(
  component: RegistryComponent,
  version: string,
): void {
  const versionData: PackumentVersion = {
    name: component.name,
    type: component.type,
    version,
  }
  if (component.description != null) {
    versionData.description = component.description
  }
  if (Array.isArray(component.dependencies)) {
    versionData.dependencies = component.dependencies
  }

  const packument: Packument = {
    name: component.name,
    'dist-tags': { latest: version },
    versions: { [version]: versionData },
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'components', `${component.name}.json`),
    JSON.stringify(packument, null, 2) + '\n',
  )
}

function buildPluginPackument(
  component: RegistryComponent,
  version: string,
): void {
  const versionData: PackumentVersion = {
    name: component.name,
    type: component.type,
    version,
  }
  if (component.description != null) {
    versionData.description = component.description
  }
  if (component.opencode != null) {
    versionData.opencode = component.opencode
  }

  const packument: Packument = {
    name: component.name,
    'dist-tags': { latest: version },
    versions: { [version]: versionData },
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'components', `${component.name}.json`),
    JSON.stringify(packument, null, 2) + '\n',
  )
}

function main(): void {
  const { version: explicitVersion, validateOnly } = parseArgs()
  const version = resolveVersion(explicitVersion)
  const source = loadRegistrySource()

  console.log(`Registry: ${source.name} (${source.namespace})`)
  console.log(`Version: ${version}`)
  console.log(`Components: ${source.components.length}`)
  console.log('')

  const errors = validateRegistry(source)

  if (errors.length > 0) {
    console.error(`Validation failed with ${errors.length} error(s):`)
    for (const error of errors) {
      console.error(`  - ${error}`)
    }
    process.exit(1)
  }

  console.log('Validation passed.')

  if (validateOnly) {
    console.log('--validate-only: skipping build output.')
    return
  }

  buildRegistry(source, version)

  const componentCount = source.components.length
  const fileComponents = source.components.filter(
    (c) => Array.isArray(c.files) && c.files.length > 0,
  )
  const totalFiles = fileComponents.reduce(
    (sum, c) => sum + (c.files?.length ?? 0),
    0,
  )

  console.log('')
  console.log(`Built registry to ${path.relative(PROJECT_ROOT, OUTPUT_DIR)}/`)
  console.log(`  index.json: ${componentCount} components`)
  console.log(`  packuments: ${source.components.length}`)
  console.log(`  files copied: ${totalFiles}`)
}

main()
