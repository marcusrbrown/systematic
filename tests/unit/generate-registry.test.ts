import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseJsonc } from 'jsonc-parser'
import {
  type ComponentEntry,
  countComponents,
  EXCLUDED_DIR_NAMES,
  EXCLUDED_FILE_NAMES,
  EXCLUDED_FILE_PATTERNS,
  generateRegistryContent,
  isExcludedFile,
  normalizeForCompare,
  type RegistryOutput,
  SCHEMA_URL,
  sanitizeComponentName,
} from '../../scripts/generate-registry.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')

const TEMP_ROOTS: string[] = []

function makeFixtureRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-registry-'))
  TEMP_ROOTS.push(tmp)
  fs.mkdirSync(path.join(tmp, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'registry'), { recursive: true })
  return tmp
}

function writeFile(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function writeSkill(
  root: string,
  dirName: string,
  description: string,
  extraFiles: Record<string, string> = {},
): void {
  writeFile(
    root,
    `skills/${dirName}/SKILL.md`,
    `---\nname: ${dirName}\ndescription: ${description}\n---\n# ${dirName}\n`,
  )
  for (const [relPath, content] of Object.entries(extraFiles)) {
    writeFile(root, `skills/${dirName}/${relPath}`, content)
  }
}

function writeAgent(
  root: string,
  category: string,
  name: string,
  description: string,
): void {
  writeFile(
    root,
    `agents/${category}/${name}.md`,
    `---\nname: ${name}\ndescription: ${description}\n---\nAgent body.\n`,
  )
}

function writeSeedRegistry(
  root: string,
  components: ComponentEntry[],
  meta: Partial<RegistryOutput> = {},
): void {
  const registry = {
    $schema: meta.$schema ?? SCHEMA_URL,
    name: meta.name ?? 'Test',
    namespace: meta.namespace ?? 'test',
    version: meta.version ?? '0.0.0',
    author: meta.author ?? '',
    components,
  }
  writeFile(
    root,
    'registry/registry.jsonc',
    `// header\n${JSON.stringify(registry, null, 2)}\n`,
  )
}

function parseRegistry(content: string): RegistryOutput {
  return parseJsonc(content) as RegistryOutput
}

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

beforeEach(() => {
  // Each test gets its own fixture; nothing to reset globally.
})

// ---------------------------------------------------------------------------

describe('sanitizeComponentName', () => {
  test('replaces underscores with hyphens', () => {
    expect(sanitizeComponentName('generate_command')).toBe('generate-command')
    expect(sanitizeComponentName('foo_bar_baz')).toBe('foo-bar-baz')
  })

  test('preserves hyphens and lowercase alphanumerics', () => {
    expect(sanitizeComponentName('agent-browser')).toBe('agent-browser')
    expect(sanitizeComponentName('ce-brainstorm')).toBe('ce-brainstorm')
  })
})

describe('isExcludedFile', () => {
  test('excludes .DS_Store, .gitkeep, AGENTS.md', () => {
    expect(isExcludedFile('/tmp/skills/foo/.DS_Store')).toBe(true)
    expect(isExcludedFile('/tmp/skills/foo/.gitkeep')).toBe(true)
    expect(isExcludedFile('/tmp/skills/foo/AGENTS.md')).toBe(true)
  })

  test('excludes .bak/.tmp/~ patterns', () => {
    expect(isExcludedFile('/tmp/skills/foo/SKILL.md.bak')).toBe(true)
    expect(isExcludedFile('/tmp/skills/foo/notes.tmp')).toBe(true)
    expect(isExcludedFile('/tmp/skills/foo/old~')).toBe(true)
  })

  test('excludes node_modules/__pycache__/.pytest_cache directories', () => {
    expect(isExcludedFile('/tmp/skills/foo/node_modules/lib.js')).toBe(true)
    expect(isExcludedFile('/tmp/skills/foo/__pycache__/main.pyc')).toBe(true)
    expect(
      isExcludedFile('/tmp/skills/foo/.pytest_cache/v/cache/lastfailed'),
    ).toBe(true)
  })

  test('does not exclude regular files', () => {
    expect(isExcludedFile('/tmp/skills/foo/SKILL.md')).toBe(false)
    expect(isExcludedFile('/tmp/skills/foo/references/x.md')).toBe(false)
    expect(isExcludedFile('/tmp/skills/foo/scripts/run.sh')).toBe(false)
  })
})

describe('exclusion sets are non-empty', () => {
  test('EXCLUDED_FILE_NAMES has at least the documented entries', () => {
    expect(EXCLUDED_FILE_NAMES.has('.DS_Store')).toBe(true)
    expect(EXCLUDED_FILE_NAMES.has('.gitkeep')).toBe(true)
    expect(EXCLUDED_FILE_NAMES.has('AGENTS.md')).toBe(true)
  })

  test('EXCLUDED_FILE_PATTERNS has at least .bak/.tmp/~', () => {
    expect(EXCLUDED_FILE_PATTERNS.length).toBeGreaterThanOrEqual(3)
  })

  test('EXCLUDED_DIR_NAMES has at least node_modules', () => {
    expect(EXCLUDED_DIR_NAMES.has('node_modules')).toBe(true)
  })
})

describe('countComponents', () => {
  test('returns the number of components in registry content', () => {
    const content = `// header\n${JSON.stringify(
      { components: [{ name: 'a' }, { name: 'b' }] },
      null,
      2,
    )}\n`
    expect(countComponents(content)).toBe(2)
  })

  test('returns 0 for invalid input', () => {
    expect(countComponents('not jsonc {{')).toBe(0)
  })
})

describe('normalizeForCompare', () => {
  test('strips trailing whitespace and newlines', () => {
    expect(normalizeForCompare('foo\n\n  ')).toBe('foo')
    expect(normalizeForCompare('foo')).toBe('foo')
  })
})

// ---------------------------------------------------------------------------
// generateRegistryContent — happy paths

describe('generateRegistryContent — discovery', () => {
  test('discovers a skill with SKILL.md and references', () => {
    const root = makeFixtureRepo()
    writeSkill(root, 'agent-browser', 'Browser automation skill.', {
      'references/commands.md': '# Commands',
      'templates/run.sh': '#!/bin/sh',
    })
    writeSeedRegistry(root, [])

    const output = parseRegistry(generateRegistryContent(root))
    const skill = output.components.find((c) => c.name === 'agent-browser')
    expect(skill).toBeDefined()
    expect(skill?.type).toBe('skill')
    expect(skill?.description).toBe('Browser automation skill.')
    expect(skill?.files).toEqual([
      'skills/agent-browser/SKILL.md',
      'skills/agent-browser/references/commands.md',
      'skills/agent-browser/templates/run.sh',
    ])
  })

  test('discovers an agent with agent- prefix on component name', () => {
    const root = makeFixtureRepo()
    writeAgent(root, 'review', 'foo-bar', 'Reviews things.')
    writeSeedRegistry(root, [])

    const output = parseRegistry(generateRegistryContent(root))
    const agent = output.components.find((c) => c.name === 'agent-foo-bar')
    expect(agent).toBeDefined()
    expect(agent?.type).toBe('agent')
    expect(agent?.description).toBe('Reviews things.')
    expect(agent?.files).toEqual(['agents/review/foo-bar.md'])
  })

  test('sanitizes underscores in skill directory names', () => {
    const root = makeFixtureRepo()
    writeSkill(root, 'generate_command', 'Generates commands.')
    writeSeedRegistry(root, [])

    const output = parseRegistry(generateRegistryContent(root))
    const skill = output.components.find((c) => c.name === 'generate-command')
    expect(skill).toBeDefined()
    expect(skill?.type).toBe('skill')
    // Files keep the actual on-disk directory name, only the component name is sanitized
    expect(skill?.files).toEqual(['skills/generate_command/SKILL.md'])
  })

  test('excludes .DS_Store, .gitkeep, AGENTS.md from skill file lists', () => {
    const root = makeFixtureRepo()
    writeSkill(root, 'foo', 'Foo skill.', {
      '.DS_Store': '\0\0',
      '.gitkeep': '',
      'AGENTS.md': '# agents',
      'references/keep.md': 'keep me',
    })
    writeSeedRegistry(root, [])

    const output = parseRegistry(generateRegistryContent(root))
    const skill = output.components.find((c) => c.name === 'foo')
    expect(skill).toBeDefined()
    expect(skill?.files).toEqual([
      'skills/foo/SKILL.md',
      'skills/foo/references/keep.md',
    ])
  })
})

// ---------------------------------------------------------------------------
// generateRegistryContent — output shape

describe('generateRegistryContent — output shape', () => {
  test('uses V2 schema URL and unprefixed types', () => {
    const root = makeFixtureRepo()
    writeSkill(root, 'foo', 'Foo skill.')
    writeAgent(root, 'review', 'bar', 'Bar agent.')
    writeSeedRegistry(root, [])

    const content = generateRegistryContent(root)
    const output = parseRegistry(content)

    expect(output.$schema).toBe(SCHEMA_URL)
    for (const c of output.components) {
      expect(c.type.startsWith('ocx:')).toBe(false)
    }
  })

  test('uses string shorthand for generated file entries', () => {
    const root = makeFixtureRepo()
    writeSkill(root, 'foo', 'Foo skill.')
    writeSeedRegistry(root, [])

    const output = parseRegistry(generateRegistryContent(root))
    const skill = output.components.find((c) => c.name === 'foo')
    expect(skill).toBeDefined()
    for (const file of skill?.files ?? []) {
      expect(typeof file).toBe('string')
    }
  })

  test('sorts generated components alphabetically with curated entries after', () => {
    const root = makeFixtureRepo()
    writeSkill(root, 'zebra', 'Zebra.')
    writeSkill(root, 'apple', 'Apple.')
    writeAgent(root, 'review', 'cat', 'Cat.')
    writeSeedRegistry(root, [
      {
        name: 'standalone',
        type: 'profile',
        description: 'A profile.',
        files: [{ path: 'p/p.jsonc', target: 'opencode.jsonc' }],
      },
    ])

    const output = parseRegistry(generateRegistryContent(root))
    const names = output.components.map((c) => c.name)
    // Generated (alphabetical), then curated
    expect(names).toEqual(['agent-cat', 'apple', 'zebra', 'standalone'])
  })

  test('writes a fresh header comment block', () => {
    const root = makeFixtureRepo()
    writeSkill(root, 'foo', 'Foo skill.')
    writeSeedRegistry(root, [], {
      // Old V1 header that should NOT be preserved
    })
    // Manually overwrite with a stale header
    fs.writeFileSync(
      path.join(root, 'registry/registry.jsonc'),
      `// STALE V1 COMMENT — should not survive\n${JSON.stringify(
        { components: [] },
        null,
        2,
      )}\n`,
    )

    const content = generateRegistryContent(root)
    expect(content).toContain('// OCX Registry Source for Systematic')
    expect(content).toContain('Skill and agent components are auto-generated')
    expect(content).not.toContain('STALE V1 COMMENT')
  })
})

// ---------------------------------------------------------------------------
// Curated entry preservation + bundle dependency auto-population

describe('generateRegistryContent — curated preservation', () => {
  test('preserves bundle/profile/plugin entries with V2 type migration', () => {
    const root = makeFixtureRepo()
    writeSkill(root, 'foo', 'Foo skill.')
    writeSeedRegistry(root, [
      {
        name: 'standalone',
        type: 'ocx:profile',
        description: 'A profile.',
        files: [{ path: 'p/p.jsonc', target: 'opencode.jsonc' }],
      },
      {
        name: 'plugin',
        type: 'ocx:plugin',
        description: 'A plugin.',
        files: [],
        opencode: { plugins: { '@x/y': {} } },
      },
    ])

    const output = parseRegistry(generateRegistryContent(root))

    const profile = output.components.find((c) => c.name === 'standalone')
    expect(profile).toBeDefined()
    expect(profile?.type).toBe('profile')
    expect(profile?.files).toEqual([
      { path: 'p/p.jsonc', target: 'opencode.jsonc' },
    ])

    const plugin = output.components.find((c) => c.name === 'plugin')
    expect(plugin).toBeDefined()
    expect(plugin?.type).toBe('plugin')
    expect(plugin?.opencode).toEqual({ plugins: { '@x/y': {} } })
  })

  test('auto-populates skills bundle dependencies from generated skills', () => {
    const root = makeFixtureRepo()
    writeSkill(root, 'zebra', 'Zebra.')
    writeSkill(root, 'apple', 'Apple.')
    writeSeedRegistry(root, [
      {
        name: 'skills',
        type: 'bundle',
        description: 'All skills',
        dependencies: ['stale-old-name'],
        files: [],
      },
    ])

    const output = parseRegistry(generateRegistryContent(root))
    const bundle = output.components.find((c) => c.name === 'skills')
    expect(bundle).toBeDefined()
    expect(bundle?.dependencies).toEqual(['apple', 'zebra'])
  })

  test('auto-populates agents bundle dependencies from generated agents', () => {
    const root = makeFixtureRepo()
    writeAgent(root, 'review', 'cat', 'Cat.')
    writeAgent(root, 'design', 'bird', 'Bird.')
    writeSeedRegistry(root, [
      {
        name: 'agents',
        type: 'bundle',
        description: 'All agents',
        dependencies: [],
        files: [],
      },
    ])

    const output = parseRegistry(generateRegistryContent(root))
    const bundle = output.components.find((c) => c.name === 'agents')
    expect(bundle).toBeDefined()
    expect(bundle?.dependencies).toEqual(['agent-bird', 'agent-cat'])
  })

  test('does not touch non-aggregator bundle dependencies', () => {
    const root = makeFixtureRepo()
    writeSkill(root, 'foo', 'Foo.')
    writeSeedRegistry(root, [
      {
        name: 'custom-bundle',
        type: 'bundle',
        description: 'Custom',
        dependencies: ['something-specific'],
        files: [],
      },
    ])

    const output = parseRegistry(generateRegistryContent(root))
    const bundle = output.components.find((c) => c.name === 'custom-bundle')
    expect(bundle?.dependencies).toEqual(['something-specific'])
  })
})

// ---------------------------------------------------------------------------
// Error handling

describe('generateRegistryContent — error handling', () => {
  test('throws on skill with empty description', () => {
    const root = makeFixtureRepo()
    writeFile(
      root,
      'skills/empty/SKILL.md',
      `---\nname: empty\ndescription: ""\n---\nbody`,
    )
    writeSeedRegistry(root, [])

    expect(() => generateRegistryContent(root)).toThrow(/empty description/)
  })

  test('throws on agent with empty description', () => {
    const root = makeFixtureRepo()
    writeFile(
      root,
      'agents/review/empty.md',
      `---\nname: empty\ndescription: ""\n---\nbody`,
    )
    writeSeedRegistry(root, [])

    expect(() => generateRegistryContent(root)).toThrow(/empty description/)
  })
})

// ---------------------------------------------------------------------------
// Idempotence and check mode integration

describe('generateRegistryContent — idempotence', () => {
  test('produces identical output on consecutive runs', () => {
    const root = makeFixtureRepo()
    writeSkill(root, 'foo', 'Foo.')
    writeAgent(root, 'review', 'bar', 'Bar.')
    writeSeedRegistry(root, [
      {
        name: 'skills',
        type: 'bundle',
        description: 'All skills',
        dependencies: [],
        files: [],
      },
    ])

    const first = generateRegistryContent(root)
    fs.writeFileSync(path.join(root, 'registry/registry.jsonc'), first)
    const second = generateRegistryContent(root)

    expect(first).toBe(second)
  })

  test('--check happy path against real repo registry', () => {
    // Use the real repo: registry.jsonc is up to date in HEAD.
    const result = Bun.spawnSync(
      ['bun', path.join(REPO_ROOT, 'scripts/generate-registry.ts'), '--check'],
      {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('is up to date')
  })

  test('drift detection: generated content differs from a registry missing new components', () => {
    const root = makeFixtureRepo()
    writeSkill(root, 'foo', 'Foo.')
    writeSeedRegistry(root, []) // empty registry — missing the new skill

    const generated = generateRegistryContent(root)
    const existing = fs.readFileSync(
      path.join(root, 'registry/registry.jsonc'),
      'utf8',
    )
    expect(normalizeForCompare(existing)).not.toBe(
      normalizeForCompare(generated),
    )
    expect(generated).toContain('"name": "foo"')
  })
})
