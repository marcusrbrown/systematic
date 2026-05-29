import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateStats, type Stats } from './generate-stats.js'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'generate-stats-'))
}

function setupFixtureTree(
  rootDir: string,
  opts: {
    skills?: string[]
    agents?: Record<string, string[]>
    registryComponents?: { name: string; type: string }[]
    version?: string
  },
): void {
  const {
    skills = [],
    agents = {},
    registryComponents = [],
    version = '1.0.0',
  } = opts

  // Create skills/<name>/SKILL.md
  for (const skill of skills) {
    const skillDir = path.join(rootDir, 'skills', skill)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `# ${skill}\n\nA skill.\n`,
    )
  }

  // Create agents/<category>/<name>.md
  for (const [category, names] of Object.entries(agents)) {
    const catDir = path.join(rootDir, 'agents', category)
    fs.mkdirSync(catDir, { recursive: true })
    for (const name of names) {
      fs.writeFileSync(path.join(catDir, `${name}.md`), `# ${name}\n`)
    }
  }

  // Create registry/registry.jsonc
  const registryDir = path.join(rootDir, 'registry')
  fs.mkdirSync(registryDir, { recursive: true })
  const registry = {
    $schema: 'https://ocx.kdco.dev/schemas/v2/registry.json',
    name: 'Test',
    namespace: 'test',
    version: '0.0.0',
    author: '',
    components: registryComponents,
  }
  fs.writeFileSync(
    path.join(registryDir, 'registry.jsonc'),
    `${JSON.stringify(registry, null, 2)}\n`,
  )

  // Create package.json
  fs.writeFileSync(
    path.join(rootDir, 'package.json'),
    `${JSON.stringify({ name: 'test-pkg', version }, null, 2)}\n`,
  )
}

describe('generateStats', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('happy path: emits correct counts from a fixture tree', () => {
    setupFixtureTree(tmpDir, {
      skills: ['ce-plan', 'ce-brainstorm', 'git-commit'],
      agents: {
        review: ['correctness-reviewer', 'adversarial-reviewer'],
        docs: ['document-reviewer'],
      },
      registryComponents: [
        { name: 'ce-plan', type: 'skill' },
        { name: 'ce-brainstorm', type: 'skill' },
        { name: 'agent-correctness-reviewer', type: 'agent' },
        { name: 'skills', type: 'bundle' },
      ],
      version: '2.24.0',
    })

    const stats = generateStats(tmpDir)

    expect(stats.skills).toBe(3)
    expect(stats.agents).toBe(3)
    expect(stats.components).toBe(4)
    expect(stats.version).toBe('2.24.0')
  })

  it('reads version from package.json, not hardcoded', () => {
    setupFixtureTree(tmpDir, {
      skills: ['ce-review'],
      agents: { review: ['consistency-reviewer'] },
      registryComponents: [{ name: 'ce-review', type: 'skill' }],
      version: '7.13.42',
    })

    const stats = generateStats(tmpDir)

    expect(stats.version).toBe('7.13.42')
  })

  it('real semver in package.json is used directly; git resolver is not consulted', () => {
    setupFixtureTree(tmpDir, {
      skills: ['ce-plan'],
      agents: { review: ['correctness-reviewer'] },
      registryComponents: [{ name: 'ce-plan', type: 'skill' }],
      version: '3.1.4',
    })
    const gitResolver = (): string | null => {
      throw new Error('git resolver must not be called for a real semver')
    }

    const stats = generateStats(tmpDir, gitResolver)

    expect(stats.version).toBe('3.1.4')
  })

  it('semantic-release placeholder + git resolver returns tag → version is stripped tag', () => {
    setupFixtureTree(tmpDir, {
      skills: ['ce-plan'],
      agents: { review: ['correctness-reviewer'] },
      registryComponents: [{ name: 'ce-plan', type: 'skill' }],
      version: '0.0.0-semantic-release',
    })
    const gitResolver = (): string | null => 'v2.24.0'

    const stats = generateStats(tmpDir, gitResolver)

    expect(stats.version).toBe('2.24.0')
  })

  it('placeholder + git resolver returns null → version is "unreleased", no throw', () => {
    setupFixtureTree(tmpDir, {
      skills: ['ce-plan'],
      agents: { review: ['correctness-reviewer'] },
      registryComponents: [{ name: 'ce-plan', type: 'skill' }],
      version: '0.0.0-semantic-release',
    })
    const gitResolver = (): string | null => null

    const stats = generateStats(tmpDir, gitResolver)

    expect(stats.version).toBe('unreleased')
  })

  it('throws loudly when registry.jsonc is missing', () => {
    // Set up everything except the registry
    const skillDir = path.join(tmpDir, 'skills', 'ce-plan')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# ce-plan\n')
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      `${JSON.stringify({ version: '1.0.0' })}\n`,
    )

    expect(() => generateStats(tmpDir)).toThrow()
  })

  it('throws loudly when registry.jsonc has no components array', () => {
    setupFixtureTree(tmpDir, {
      skills: ['ce-plan'],
      agents: { review: ['correctness-reviewer'] },
      version: '1.0.0',
    })
    // Overwrite registry.jsonc with empty object (no components)
    fs.writeFileSync(
      path.join(tmpDir, 'registry', 'registry.jsonc'),
      `${JSON.stringify({ name: 'empty' })}\n`,
    )

    expect(() => generateStats(tmpDir)).toThrow()
  })

  it('idempotence: running twice produces byte-identical output', () => {
    const outputPath = path.join(tmpDir, 'stats.json')
    setupFixtureTree(tmpDir, {
      skills: ['ce-plan', 'git-worktree'],
      agents: {
        review: ['correctness-reviewer'],
        design: ['ux-reviewer'],
      },
      registryComponents: [
        { name: 'ce-plan', type: 'skill' },
        { name: 'agent-correctness-reviewer', type: 'agent' },
      ],
      version: '2.24.0',
    })

    const stats1 = generateStats(tmpDir)
    const json1 = serializeStats(stats1)
    fs.writeFileSync(outputPath, json1)

    const stats2 = generateStats(tmpDir)
    const json2 = serializeStats(stats2)

    expect(json2).toBe(json1)
  })
})

// Mirror the serialization the script uses so the idempotence test is meaningful.
function serializeStats(stats: Stats): string {
  return `${JSON.stringify(stats, null, 2)}\n`
}
