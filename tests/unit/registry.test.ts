import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseJsonc } from 'jsonc-parser'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const REGISTRY_PATH = path.join(PROJECT_ROOT, 'registry/registry.jsonc')

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

interface RegistryManifest {
  $schema?: string
  name: string
  namespace: string
  version: string
  author?: string
  components: RegistryComponent[]
}

function loadRegistry(): RegistryManifest {
  const content = fs.readFileSync(REGISTRY_PATH, 'utf-8')
  return parseJsonc(content) as RegistryManifest
}

function resolveComponentFilePath(
  component: RegistryComponent,
  file: RegistryFile,
): string {
  const type = component.type

  if (type === 'ocx:skill') {
    return path.join(PROJECT_ROOT, 'skills', component.name, file.path)
  }

  if (type === 'ocx:agent' || type === 'ocx:command') {
    return path.join(PROJECT_ROOT, file.path)
  }

  return path.join(PROJECT_ROOT, 'registry/files', file.path)
}

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

function validateComponentFiles(
  component: RegistryComponent,
  requiredType: string,
): string[] {
  const errors: string[] = []

  if (component.type === requiredType) {
    if (!Array.isArray(component.files) || component.files.length === 0) {
      errors.push(`[${component.name}] Must have at least one file`)
    }

    if (Array.isArray(component.files)) {
      for (const file of component.files) {
        if (!file.path.endsWith('.md')) {
          errors.push(`[${component.name}] Non-.md file: ${file.path}`)
        }
      }
    }
  }

  return errors
}

function collectDiskFiles(skillDir: string): Set<string> {
  const diskFiles = walkFiles(skillDir)
  const declaredSet = new Set<string>()

  for (const diskFile of diskFiles) {
    const rel = path.relative(skillDir, diskFile)
    declaredSet.add(rel)
  }

  return declaredSet
}

function assertAllFilesExist(component: RegistryComponent): string[] {
  const errors: string[] = []

  if (Array.isArray(component.files)) {
    for (const file of component.files) {
      const diskPath = resolveComponentFilePath(component, file)
      if (!fs.existsSync(diskPath)) {
        errors.push(
          `[${component.name}] File not found: ${file.path} (expected at ${diskPath})`,
        )
      }
    }
  }

  return errors
}

function getComponentsByType(
  components: RegistryComponent[],
  type: string,
): RegistryComponent[] {
  return components.filter((c) => c.type === type)
}

describe('Registry Manifest', () => {
  it('should be valid JSONC', () => {
    const content = fs.readFileSync(REGISTRY_PATH, 'utf-8')
    const parsed = parseJsonc(content)
    expect(parsed).toBeDefined()
    expect(typeof parsed).toBe('object')
    expect(parsed).not.toBeNull()
  })

  it('should have required top-level fields', () => {
    const registry = loadRegistry()
    expect(registry.name).toBe('Systematic')
    expect(registry.namespace).toBe('systematic')
    expect(registry.version).toBeDefined()
    expect(Array.isArray(registry.components)).toBe(true)
  })

  it('should have correct namespace', () => {
    const registry = loadRegistry()
    expect(registry.namespace).toBe('systematic')
  })

  it('should have schema reference', () => {
    const registry = loadRegistry()
    expect(registry.$schema).toBe('https://ocx.kdco.dev/schemas/registry.json')
  })

  it('should have 48 total components', () => {
    const registry = loadRegistry()
    expect(registry.components).toHaveLength(48)
  })

  it('should have correct component type distribution', () => {
    const registry = loadRegistry()
    const byType = registry.components.reduce(
      (acc, c) => {
        acc[c.type] = (acc[c.type] ?? 0) + 1
        return acc
      },
      {} as Record<string, number>,
    )

    expect(byType['ocx:skill']).toBe(11)
    expect(byType['ocx:agent']).toBe(24)
    expect(byType['ocx:command']).toBe(9)
    expect(byType['ocx:bundle']).toBe(3)
    expect(byType['ocx:plugin']).toBe(1)
  })
})

describe('Component Types', () => {
  const VALID_TYPES = [
    'ocx:skill',
    'ocx:agent',
    'ocx:command',
    'ocx:bundle',
    'ocx:plugin',
  ]

  it('should only contain valid OCX component types', () => {
    const registry = loadRegistry()

    for (const component of registry.components) {
      expect(VALID_TYPES).toContain(component.type)
    }
  })

  it('should have type-specific required fields', () => {
    const registry = loadRegistry()

    for (const component of registry.components) {
      expect(component.name).toBeDefined()
      expect(typeof component.name).toBe('string')
      expect(component.name.length).toBeGreaterThan(0)

      expect(component.type).toBeDefined()
      expect(typeof component.type).toBe('string')
    }
  })
})

describe('File Existence', () => {
  it('should have all referenced files exist on disk', () => {
    const registry = loadRegistry()
    const errors: string[] = []

    for (const component of registry.components) {
      if (component.type === 'ocx:bundle' || component.type === 'ocx:plugin') {
        continue
      }

      errors.push(...assertAllFilesExist(component))
    }

    if (errors.length > 0) {
      throw new Error(`File existence check failed:\n  ${errors.join('\n  ')}`)
    }
  })

  it('should have SKILL.md for all skill components', () => {
    const registry = loadRegistry()
    const errors: string[] = []

    for (const component of registry.components) {
      if (component.type === 'ocx:skill') {
        const hasSkillMd =
          Array.isArray(component.files) &&
          component.files.some((f) => f.path === 'SKILL.md')

        if (!hasSkillMd) {
          errors.push(`[${component.name}] Missing SKILL.md`)
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Skill validation failed:\n  ${errors.join('\n  ')}`)
    }
  })

  it('should have .md files for agent and command components', () => {
    const registry = loadRegistry()
    const errors: string[] = []

    for (const component of registry.components) {
      if (component.type === 'ocx:agent' || component.type === 'ocx:command') {
        errors.push(...validateComponentFiles(component, component.type))
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Agent/Command validation failed:\n  ${errors.join('\n  ')}`,
      )
    }
  })
})

describe('Multi-file Completeness', () => {
  it('should list ALL files in multi-file skill directories', () => {
    const registry = loadRegistry()
    const errors: string[] = []

    for (const component of getComponentsByType(
      registry.components,
      'ocx:skill',
    )) {
      const skillDir = path.join(PROJECT_ROOT, 'skills', component.name)
      if (!fs.existsSync(skillDir)) {
        errors.push(
          `[${component.name}] Skill directory not found: ${skillDir}`,
        )
        continue
      }

      const declaredPaths = new Set(component.files?.map((f) => f.path) ?? [])
      const diskFiles = collectDiskFiles(skillDir)

      for (const diskFile of diskFiles) {
        if (!declaredPaths.has(diskFile)) {
          errors.push(`[${component.name}] Unlisted file: ${diskFile}`)
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Multi-file completeness check failed:\n  ${errors.join('\n  ')}`,
      )
    }
  })

  it('should not include .DS_Store files in any component', () => {
    const registry = loadRegistry()
    const errors: string[] = []

    for (const component of registry.components) {
      if (!Array.isArray(component.files)) continue

      for (const file of component.files) {
        if (file.path.includes('.DS_Store')) {
          errors.push(`[${component.name}] Contains .DS_Store: ${file.path}`)
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `.DS_Store exclusion check failed:\n  ${errors.join('\n  ')}`,
      )
    }
  })

  it('should have correct file counts for known multi-file skills', () => {
    const registry = loadRegistry()
    const expectedCounts: Record<string, number> = {
      'create-agent-skills': 26,
      'agent-native-architecture': 15,
      'compound-docs': 5,
      'file-todos': 2,
      'git-worktree': 2,
    }

    for (const component of registry.components) {
      if (component.name in expectedCounts) {
        const actualCount = component.files?.length ?? 0
        expect(actualCount).toBe(expectedCounts[component.name])
      }
    }
  })
})

describe('Bundle Integrity', () => {
  it('should have bundle components reference only existing components', () => {
    const registry = loadRegistry()
    const allComponentNames = new Set(registry.components.map((c) => c.name))
    const errors: string[] = []

    for (const component of getComponentsByType(
      registry.components,
      'ocx:bundle',
    )) {
      if (
        !Array.isArray(component.dependencies) ||
        component.dependencies.length === 0
      ) {
        errors.push(
          `[${component.name}] Bundle must have at least one dependency`,
        )
        continue
      }

      for (const dep of component.dependencies) {
        if (!allComponentNames.has(dep)) {
          errors.push(
            `[${component.name}] References unknown component: "${dep}"`,
          )
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Bundle validation failed:\n  ${errors.join('\n  ')}`)
    }
  })

  it('should have correct bundle compositions', () => {
    const registry = loadRegistry()

    const skillsBundle = registry.components.find((c) => c.name === 'skills')
    expect(skillsBundle).toBeDefined()
    expect(skillsBundle?.type).toBe('ocx:bundle')
    expect(skillsBundle?.dependencies).toHaveLength(11)

    const agentsBundle = registry.components.find((c) => c.name === 'agents')
    expect(agentsBundle).toBeDefined()
    expect(agentsBundle?.type).toBe('ocx:bundle')
    expect(agentsBundle?.dependencies).toHaveLength(24)

    const commandsBundle = registry.components.find(
      (c) => c.name === 'commands',
    )
    expect(commandsBundle).toBeDefined()
    expect(commandsBundle?.type).toBe('ocx:bundle')
    expect(commandsBundle?.dependencies).toHaveLength(9)
  })
})

describe('Profile Structure', () => {
  it('should have profile components with required files', () => {
    const registry = loadRegistry()
    const profiles = registry.components.filter((c) =>
      c.name.startsWith('profile-'),
    )

    if (profiles.length === 0) {
      return
    }

    for (const profile of profiles) {
      const filePaths = profile.files?.map((f) => f.path) ?? []

      expect(filePaths).toContain('opencode.jsonc')
      expect(filePaths).toContain('AGENTS.md')
    }
  })
})

describe('No Duplicates', () => {
  it('should not have duplicate component names', () => {
    const registry = loadRegistry()
    const names = registry.components.map((c) => c.name)
    const uniqueNames = new Set(names)

    expect(names.length).toBe(uniqueNames.size)
  })

  it('should have unique names across all component types', () => {
    const registry = loadRegistry()
    const namesByType: Record<string, string[]> = {}

    for (const component of registry.components) {
      if (namesByType[component.type] == null) {
        namesByType[component.type] = []
      }
      namesByType[component.type].push(component.name)
    }

    for (const names of Object.values(namesByType)) {
      const uniqueNames = new Set(names)
      expect(names.length).toBe(uniqueNames.size)
    }
  })
})

describe('Component Naming', () => {
  it('should have agent components prefixed with agent-', () => {
    const registry = loadRegistry()

    for (const component of registry.components) {
      if (component.type === 'ocx:agent') {
        expect(component.name.startsWith('agent-')).toBe(true)
      }
    }
  })

  it('should have command components prefixed with cmd-', () => {
    const registry = loadRegistry()

    for (const component of registry.components) {
      if (component.type === 'ocx:command') {
        expect(component.name.startsWith('cmd-')).toBe(true)
      }
    }
  })
})
