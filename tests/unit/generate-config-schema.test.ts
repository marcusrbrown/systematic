import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_AGENT_NAMES,
  BUNDLED_AGENT_QUALIFIED_IDS,
  BUNDLED_SKILL_NAMES,
} from '../../src/lib/bundled-names.js'
import { createSystematicConfigSchema } from '../../src/lib/config-schema.js'
import {
  REMOVED_BUNDLED_AGENT_NAMES,
  REMOVED_BUNDLED_SKILL_NAMES,
} from '../../src/lib/removed-names.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TEMP_ROOTS: string[] = []

function makeTempRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-config-schema-'))
  TEMP_ROOTS.push(tmp)
  return tmp
}

function writeFile(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}

function writePackageJson(root: string, version: string): void {
  writeFile(root, 'package.json', JSON.stringify({ version }))
}

function writeSchemaFile(root: string, relPath: string, content: string): void {
  writeFile(root, relPath, content)
}

function parseSchema(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>
}

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ═════════════════════════════════════════════════════════════════
// Import / module resolution (TDD first check)
// ═════════════════════════════════════════════════════════════════

describe('module resolution', () => {
  test('imports from the generator script', async () => {
    // This test verifies the module can be resolved.
    // It should fail with "module not found" until the generator exists.
    const mod = await import('../../scripts/generate-config-schema.js')
    expect(mod).toBeDefined()
    expect(typeof mod.generateSchemaContent).toBe('function')
    expect(typeof mod.resolveVersion).toBe('function')
    expect(typeof mod.normalizeForCompare).toBe('function')
    expect(typeof mod.checkSchemaFiles).toBe('function')
    expect(typeof mod.SCHEMA_ID_TEMPLATE).toBe('string')
  })
})

// ═════════════════════════════════════════════════════════════════
// resolveVersion — unit tests
// ═════════════════════════════════════════════════════════════════

describe('resolveVersion', () => {
  // These tests import from the generator dynamically after
  // verifying it exists.

  let resolveVersionFn: (explicit: string | null, rootDir?: string) => string

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.js')
    resolveVersionFn = mod.resolveVersion
  })

  test('explicit --version flag is used as-is', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '0.0.0-semantic-release') // ignored due to explicit flag
    const result = resolveVersionFn('3.0.0', tmp)
    expect(result).toBe('3.0.0')
  })

  test('explicit --version with prerelease', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '0.0.0-semantic-release')
    const result = resolveVersionFn('3.0.0-rc.1', tmp)
    expect(result).toBe('3.0.0-rc.1')
  })

  test('explicit --version overrides everything', () => {
    const tmp = makeTempRepo()
    // Set up a valid package.json that should be ignored
    writePackageJson(tmp, '1.2.3')
    const result = resolveVersionFn('99.99.99', tmp)
    expect(result).toBe('99.99.99')
  })

  test('rejects invalid explicit version', () => {
    expect(() => resolveVersionFn('not-semver', '/tmp')).toThrow(
      /Invalid version format/,
    )
  })

  test('rejects explicit version with wrong format', () => {
    expect(() => resolveVersionFn('1.2', '/tmp')).toThrow(
      /Invalid version format/,
    )
  })

  test('falls back to package.json version when no git tag and no explicit flag', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '3.0.0')
    const result = resolveVersionFn(null, tmp)
    expect(result).toBe('3.0.0')
  })

  test('rejects 0.0.0-semantic-release placeholder when no git tag and no explicit flag', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '0.0.0-semantic-release')
    expect(() => resolveVersionFn(null, tmp)).toThrow(/no resolvable version/i)
  })

  test('rejects missing package.json when no git tag and no explicit flag', () => {
    const tmp = makeTempRepo()
    // No package.json at all
    expect(() => resolveVersionFn(null, tmp)).toThrow(/no resolvable version/i)
  })

  test('resolves from git tag when one exists', () => {
    // Build a temp git repo with a known tag so the test is independent
    // of CI checkout depth and of the real repo's tag state.
    const tmp = makeTempRepo()
    writePackageJson(tmp, '0.0.0-semantic-release') // would otherwise be rejected
    const gitOpts = { cwd: tmp, stdio: 'ignore' } as const
    execSync('git init -q', gitOpts)
    execSync('git config user.email t@t.test', gitOpts)
    execSync('git config user.name test', gitOpts)
    execSync('git config commit.gpgsign false', gitOpts)
    execSync('git config tag.gpgsign false', gitOpts)
    execSync('git add package.json', gitOpts)
    execSync('git commit -q -m init --no-verify', gitOpts)
    execSync('git tag v1.2.3', gitOpts)

    const result = resolveVersionFn(null, tmp)
    expect(result).toBe('1.2.3')
  })

  test('resolves from git tag -l when describe fails (PR merge commit case)', () => {
    // Simulates the CI failure mode where the synthetic PR merge commit
    // is not an ancestor of any tag — `git describe --tags --abbrev=0`
    // fails with "No tags can describe", and we must fall through to
    // `git tag -l --sort=-v:refname` to find the most-recent semver tag.
    const tmp = makeTempRepo()
    writePackageJson(tmp, '0.0.0-semantic-release') // would otherwise be rejected
    const gitOpts = { cwd: tmp, stdio: 'ignore' } as const
    execSync('git init -q', gitOpts)
    execSync('git config user.email t@t.test', gitOpts)
    execSync('git config user.name test', gitOpts)
    execSync('git config commit.gpgsign false', gitOpts)
    execSync('git config tag.gpgsign false', gitOpts)
    execSync('git add package.json', gitOpts)
    execSync('git commit -q -m init --no-verify', gitOpts)
    execSync('git tag v2.5.0', gitOpts)
    execSync('git tag v2.12.0', gitOpts)
    // Create an orphan commit so it isn't an ancestor of either tag.
    execSync('git checkout -q --orphan unrelated', gitOpts)
    execSync('git reset -q', gitOpts)
    execSync('git commit -q --allow-empty -m unrelated --no-verify', gitOpts)

    // git describe will fail here; the fallback must pick v2.12.0 (newest).
    const result = resolveVersionFn(null, tmp)
    expect(result).toBe('2.12.0')
  })
})

// ═════════════════════════════════════════════════════════════════
// generateSchemaContent — output shape tests
// ═════════════════════════════════════════════════════════════════

describe('generateSchemaContent', () => {
  let generateSchemaContentFn: (version: string) => string

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.js')
    generateSchemaContentFn = mod.generateSchemaContent
  })

  test('$id field uses major-versioned URL (not /latest/)', () => {
    const content = generateSchemaContentFn('3.0.0')
    const parsed = parseSchema(content)
    expect(parsed.$id).toBe(
      'https://fro.bot/systematic/schemas/v3/systematic-config.schema.json',
    )
  })

  test('$id for version 2.11.0 uses v2 major', () => {
    const content = generateSchemaContentFn('2.11.0')
    const parsed = parseSchema(content)
    expect(parsed.$id).toBe(
      'https://fro.bot/systematic/schemas/v2/systematic-config.schema.json',
    )
  })

  test('$id for version 3.0.0-rc.1 uses v3 major', () => {
    const content = generateSchemaContentFn('3.0.0-rc.1')
    const parsed = parseSchema(content)
    expect(parsed.$id).toBe(
      'https://fro.bot/systematic/schemas/v3/systematic-config.schema.json',
    )
  })

  test('$schema points to draft-07', () => {
    const content = generateSchemaContentFn('3.0.0')
    const parsed = parseSchema(content)
    expect(parsed.$schema).toBe('http://json-schema.org/draft-07/schema#')
  })

  test('output is valid JSON', () => {
    const content = generateSchemaContentFn('3.0.0')
    expect(() => JSON.parse(content)).not.toThrow()
  })

  test('output has required top-level properties', () => {
    const content = generateSchemaContentFn('3.0.0')
    const parsed = parseSchema(content)
    expect(parsed.type).toBe('object')
    expect(parsed.properties).toBeDefined()
    expect(typeof parsed.properties).toBe('object')
  })

  test('properties include all six top-level config keys', () => {
    const content = generateSchemaContentFn('3.0.0')
    const parsed = parseSchema(content)
    const props = parsed.properties as Record<string, unknown>
    expect(props).toHaveProperty('agents')
    expect(props).toHaveProperty('categories')
    expect(props).toHaveProperty('disabled_skills')
    expect(props).toHaveProperty('disabled_agents')
    expect(props).toHaveProperty('disabled_commands')
    expect(props).toHaveProperty('bootstrap')
  })

  test('produces byte-identical output on consecutive calls', () => {
    const first = generateSchemaContentFn('3.0.0')
    const second = generateSchemaContentFn('3.0.0')
    expect(first).toBe(second)
  })
})

// ═════════════════════════════════════════════════════════════════
// generateSchemaContentFromSchema removed-names threading
// ═════════════════════════════════════════════════════════════════

describe('generateSchemaContentFromSchema removed-names threading', () => {
  let generateSchemaContentFromSchemaFn: (
    version: string,
    schema: import('zod').ZodType,
  ) => string
  let generateSchemaContentFn: (version: string) => string

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.js')
    generateSchemaContentFromSchemaFn = mod.generateSchemaContentFromSchema
    generateSchemaContentFn = mod.generateSchemaContent
  })

  test('synthetic removed skill name appears in disabled_skills enum of generated JSON Schema', () => {
    // Build a schema with a synthetic removed skill name to prove the
    // removed-names are threaded through to the JSON Schema output.
    const schema = createSystematicConfigSchema({
      agentNames: BUNDLED_AGENT_NAMES,
      qualifiedAgentIds: BUNDLED_AGENT_QUALIFIED_IDS,
      skillNames: BUNDLED_SKILL_NAMES,
      removedSkillNames: ['gone-skill'],
      removedAgentNames: [],
    })
    const content = generateSchemaContentFromSchemaFn('3.0.0', schema)
    // The generated JSON must contain the synthetic name somewhere in the
    // disabled_skills enum (exact path varies with Zod's $ref deduplication).
    expect(content).toContain('"gone-skill"')
  })

  test('factory schema built from the committed removed-name lists produces byte-identical output to the baseline (no drift)', () => {
    // The committed SystematicConfigSchema threads REMOVED_BUNDLED_SKILL_NAMES
    // and REMOVED_BUNDLED_AGENT_NAMES through createSystematicConfigSchema.
    // Rebuilding the factory schema with those same committed lists must
    // produce output byte-identical to the baseline generateSchemaContent.
    const schema = createSystematicConfigSchema({
      agentNames: BUNDLED_AGENT_NAMES,
      qualifiedAgentIds: BUNDLED_AGENT_QUALIFIED_IDS,
      skillNames: BUNDLED_SKILL_NAMES,
      removedSkillNames: REMOVED_BUNDLED_SKILL_NAMES,
      removedAgentNames: REMOVED_BUNDLED_AGENT_NAMES,
    })
    const fromFactory = generateSchemaContentFromSchemaFn('3.0.0', schema)
    const baseline = generateSchemaContentFn('3.0.0')
    expect(fromFactory).toBe(baseline)
  })
})

// ═════════════════════════════════════════════════════════════════
// Integration: generate+write all three files
// ═════════════════════════════════════════════════════════════════

describe('generateAndWrite — three-file output', () => {
  let generateAndWriteFn: (
    content: string,
    version: string,
    rootDir: string,
  ) => string[]

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.js')
    generateAndWriteFn = mod.generateAndWrite
  })

  test('writes three files that are byte-identical', () => {
    const tmp = makeTempRepo()
    const version = '3.0.0'
    const content = JSON.stringify({ test: true })

    const paths = generateAndWriteFn(content, version, tmp)

    // Verify three paths are returned
    expect(paths).toHaveLength(3)

    // All three files exist
    for (const p of paths) {
      expect(fs.existsSync(p)).toBe(true)
    }

    // All three are byte-identical
    const contents = paths.map((p) => fs.readFileSync(p, 'utf-8'))
    expect(contents[0]).toBe(contents[1])
    expect(contents[1]).toBe(contents[2])
  })

  test('writes to v3/, latest/, and dist/schemas/', () => {
    const tmp = makeTempRepo()
    const version = '3.0.0'
    const content = JSON.stringify({ version: 3 })

    const paths = generateAndWriteFn(content, version, tmp)
    const relPaths = paths.map((p) => path.relative(tmp, p))

    // Find the three expected paths
    const v3Path = relPaths.find(
      (p) => p.includes('schemas/v3/') && !p.includes('latest'),
    )
    const latestPath = relPaths.find((p) => p.includes('schemas/latest/'))
    const distPath = relPaths.find(
      (p) => p.startsWith('dist/') && p.includes('schemas/'),
    )

    expect(v3Path).toBeDefined()
    expect(latestPath).toBeDefined()
    expect(distPath).toBeDefined()

    if (!v3Path || !latestPath || !distPath) {
      throw new Error('Expected three schema target paths to be defined')
    }
    const v3Content = fs.readFileSync(path.join(tmp, v3Path), 'utf-8')
    const latestContent = fs.readFileSync(path.join(tmp, latestPath), 'utf-8')
    const distContent = fs.readFileSync(path.join(tmp, distPath), 'utf-8')

    expect(v3Content).toBe(latestContent)
    expect(latestContent).toBe(distContent)
  })

  test('generates v2/ directory for version 2.11.0', () => {
    const tmp = makeTempRepo()
    const version = '2.11.0'
    const content = JSON.stringify({ version: 2 })

    const paths = generateAndWriteFn(content, version, tmp)
    const relPaths = paths.map((p) => path.relative(tmp, p))

    expect(relPaths.some((p) => p.includes('schemas/v2/'))).toBe(true)
    expect(relPaths.some((p) => p.includes('schemas/latest/'))).toBe(true)
  })

  test('major bump: v3/ written, v2/ stays intact, latest/ updated', () => {
    const tmp = makeTempRepo()

    // Simulate existing v2/ schema
    const v2Id =
      'https://fro.bot/systematic/schemas/v2/systematic-config.schema.json'
    writeSchemaFile(
      tmp,
      'docs/public/schemas/v2/systematic-config.schema.json',
      JSON.stringify({ $id: v2Id }),
    )

    // Write v3
    const content = JSON.stringify({ version: 3 })
    generateAndWriteFn(content, '3.0.0', tmp)

    // v2 still intact
    const v2Content = fs.readFileSync(
      path.join(tmp, 'docs/public/schemas/v2/systematic-config.schema.json'),
      'utf-8',
    )
    expect(JSON.parse(v2Content)).toEqual({ $id: v2Id })

    // v3 written
    const v3Content = fs.readFileSync(
      path.join(tmp, 'docs/public/schemas/v3/systematic-config.schema.json'),
      'utf-8',
    )
    expect(JSON.parse(v3Content)).toEqual({ version: 3 })

    // latest/ now points to v3 content
    const latestContent = fs.readFileSync(
      path.join(
        tmp,
        'docs/public/schemas/latest/systematic-config.schema.json',
      ),
      'utf-8',
    )
    expect(JSON.parse(latestContent)).toEqual({ version: 3 })
  })

  test('second run is a no-op (byte-identical output)', () => {
    const tmp = makeTempRepo()
    const version = '3.0.0'
    const content = JSON.stringify({ stable: true })

    const firstPaths = generateAndWriteFn(content, version, tmp)
    const firstMtimes = firstPaths.map((p) => fs.statSync(p).mtimeMs)

    const secondPaths = generateAndWriteFn(content, version, tmp)
    const secondMtimes = secondPaths.map((p) => fs.statSync(p).mtimeMs)

    // mtimes should be identical (files weren't re-written)
    for (let i = 0; i < firstMtimes.length; i++) {
      expect(secondMtimes[i]).toBe(firstMtimes[i])
    }
  })
})

// ═════════════════════════════════════════════════════════════════
// normalizeForCompare — utility tests
// ═════════════════════════════════════════════════════════════════

describe('normalizeForCompare', () => {
  let normalizeForCompareFn: (content: string) => string

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.js')
    normalizeForCompareFn = mod.normalizeForCompare
  })

  test('strips trailing whitespace and newlines', () => {
    expect(normalizeForCompareFn('  foo\n\n  ')).toBe('  foo')
    expect(normalizeForCompareFn('{"a":1}\n')).toBe('{"a":1}')
  })

  test('normalizes CRLF to LF', () => {
    expect(normalizeForCompareFn('a\r\nb\r\n')).toBe('a\nb')
  })

  test('preserves content with no trailing whitespace', () => {
    expect(normalizeForCompareFn('hello world')).toBe('hello world')
  })
})

// ═════════════════════════════════════════════════════════════════
// checkSchemaFiles — drift detection
// ═════════════════════════════════════════════════════════════════

describe('checkSchemaFiles — drift detection', () => {
  let generateAndWriteFn: (
    content: string,
    version: string,
    rootDir: string,
  ) => string[]
  let generateSchemaContentFn: (version: string) => string
  let generateBundledNamesContentFn: (
    agents: string[],
    skills: string[],
    options?: {
      previousAgentCount?: number
      previousSkillCount?: number
      allowShrink?: boolean
    },
  ) => string
  let checkSchemaFilesFn: (
    rootDir: string,
    explicitVersion?: string | null,
  ) => { ok: boolean; message: string }
  let writeBundledNamesFileFn: (content: string, rootDir: string) => string

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.js')
    generateAndWriteFn = mod.generateAndWrite
    generateSchemaContentFn = mod.generateSchemaContent
    generateBundledNamesContentFn = mod.generateBundledNamesContent
    checkSchemaFilesFn = mod.checkSchemaFiles
    writeBundledNamesFileFn = mod.writeBundledNamesFile
  })

  /**
   * Seed a minimal bundled-names.ts into a temp repo AND create matching
   * agents/ and skills/ directories so that discoverBundledNames() returns
   * the same set that was committed (keeping the drift check clean).
   */
  function writeBundledNames(
    root: string,
    agents: string[],
    skills: string[],
  ): void {
    // Agents are seeded with category 'review', so qualified IDs are 'review/<name>'
    const agentQualifiedIds = agents.map((name) => `review/${name}`)
    const content = generateBundledNamesContentFn(agents, skills, {
      agentQualifiedIds,
    })
    writeBundledNamesFileFn(content, root)
    // Seed matching filesystem entries so discovery agrees with the committed file
    seedBundledFilesystem(
      root,
      agents.map((name) => ({ category: 'review', name })),
      skills,
    )
  }

  test('happy path: all files up to date — returns ok', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '3.0.0')

    // Run generator to produce clean state
    const content = generateSchemaContentFn('3.0.0')
    generateAndWriteFn(content, '3.0.0', tmp)
    writeBundledNames(tmp, ['agent-a', 'agent-b'], ['skill-a'])

    const result = checkSchemaFilesFn(tmp, '3.0.0')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('up to date')
  })

  test('detects hand-edit to one file — returns !ok with diff message', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '3.0.0')

    const content = generateSchemaContentFn('3.0.0')
    generateAndWriteFn(content, '3.0.0', tmp)
    writeBundledNames(tmp, ['agent-a', 'agent-b'], ['skill-a'])

    // Hand-edit one file
    const v3Path = path.join(
      tmp,
      'docs/public/schemas/v3/systematic-config.schema.json',
    )
    fs.writeFileSync(v3Path, JSON.stringify({ tampered: true }), 'utf-8')

    const result = checkSchemaFilesFn(tmp, '3.0.0')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('docs/public/schemas/v3')
    expect(result.message).toMatch(/out of date|differs|drift/i)
  })

  test('detects missing files — returns !ok with message', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '3.0.0')

    // Don't write anything, just check
    const result = checkSchemaFilesFn(tmp, '3.0.0')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not found|does not exist/i)
  })

  test('exits 0 when latest/ is missing but v3/ and dist/ are present', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '3.0.0')

    // Generate and write all three (v3/, latest/, dist/)
    const content = generateSchemaContentFn('3.0.0')
    generateAndWriteFn(content, '3.0.0', tmp)
    writeBundledNames(tmp, ['agent-a', 'agent-b'], ['skill-a'])

    // Delete latest/ to simulate gitignored-clean-checkout scenario
    const latestPath = path.join(
      tmp,
      'docs/public/schemas/latest/systematic-config.schema.json',
    )
    fs.rmSync(latestPath)

    // checkSchemaFiles should still pass (latest/ is derivative, not canonical)
    const result = checkSchemaFilesFn(tmp, '3.0.0')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('up to date')
  })

  test('regression: exits 0 when dist/schemas/ is absent (simulates post-build clean)', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '3.0.0')

    // Write only the committed docs path — simulate a CI run where
    // `bun run build` already cleaned dist/ before schema:drift runs
    const content = generateSchemaContentFn('3.0.0')
    writeSchemaFile(
      tmp,
      'docs/public/schemas/v3/systematic-config.schema.json',
      content,
    )
    writeBundledNames(tmp, ['agent-a', 'agent-b'], ['skill-a'])
    // Intentionally do NOT write dist/schemas/ — this is the bug scenario

    // Must pass: dist/schemas/ is a publish-only artifact, not checked here
    const result = checkSchemaFilesFn(tmp, '3.0.0')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('up to date')
  })

  // ── bundled-names drift scenarios ──────────────────────────────

  test('reports drift when bundled-names.ts is stale', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '3.0.0')

    // Write a fresh JSON Schema
    const schemaContent = generateSchemaContentFn('3.0.0')
    writeSchemaFile(
      tmp,
      'docs/public/schemas/v3/systematic-config.schema.json',
      schemaContent,
    )

    // Write bundled-names.ts with a smaller agent set than what's on disk
    writeBundledNames(tmp, ['agent-a'], ['skill-a'])

    // Now seed the filesystem with an extra agent that's NOT in bundled-names.ts
    seedBundledFilesystem(
      tmp,
      [
        { category: 'review', name: 'agent-a' },
        { category: 'review', name: 'agent-b' }, // extra — not in committed file
      ],
      ['skill-a'],
    )

    const result = checkSchemaFilesFn(tmp, '3.0.0')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('bundled-names.ts')
    expect(result.message).toMatch(/out of date|generate-config-schema/i)
  })

  test('reports error when bundled-names.ts is missing', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '3.0.0')

    // Write a fresh JSON Schema but no bundled-names.ts
    const schemaContent = generateSchemaContentFn('3.0.0')
    writeSchemaFile(
      tmp,
      'docs/public/schemas/v3/systematic-config.schema.json',
      schemaContent,
    )

    // Seed filesystem agents/skills so discovery works
    seedBundledFilesystem(
      tmp,
      [{ category: 'review', name: 'agent-a' }],
      ['skill-a'],
    )

    const result = checkSchemaFilesFn(tmp, '3.0.0')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('bundled-names.ts')
    expect(result.message).toMatch(/not found|does not exist/i)
  })

  test('aggregates both failures when both artifacts are stale', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '3.0.0')

    // Write a stale JSON Schema (wrong content)
    writeSchemaFile(
      tmp,
      'docs/public/schemas/v3/systematic-config.schema.json',
      JSON.stringify({ stale: true }),
    )

    // Write bundled-names.ts with a smaller agent set
    writeBundledNames(tmp, ['agent-a'], ['skill-a'])

    // Seed filesystem with extra agent
    seedBundledFilesystem(
      tmp,
      [
        { category: 'review', name: 'agent-a' },
        { category: 'review', name: 'agent-b' },
      ],
      ['skill-a'],
    )

    const result = checkSchemaFilesFn(tmp, '3.0.0')
    expect(result.ok).toBe(false)
    // Both artifact paths should appear in the combined message
    expect(result.message).toContain('docs/public/schemas/v3')
    expect(result.message).toContain('bundled-names.ts')
  })

  test('bundled-names drift check is independent of version resolution', () => {
    // A repo with no git tag and no resolvable package.json version.
    // The JSON Schema check will fail with "no resolvable version".
    // The bundled-names check should still detect drift on bundled-names.ts
    // independently — the combined message must mention bundled-names.ts.
    const tmp = makeTempRepo()
    // No package.json → resolveVersion will throw

    // Seed filesystem agents/skills
    seedBundledFilesystem(
      tmp,
      [
        { category: 'review', name: 'agent-a' },
        { category: 'review', name: 'agent-b' },
      ],
      ['skill-a'],
    )

    // Write a bundled-names.ts that only lists agent-a (stale — missing agent-b)
    writeBundledNames(tmp, ['agent-a'], ['skill-a'])

    // No explicit version → resolveVersion will fail; bundled-names drift should still surface
    const result = checkSchemaFilesFn(tmp, null)
    expect(result.ok).toBe(false)
    // The bundled-names drift must be mentioned regardless of version failure
    expect(result.message).toContain('bundled-names.ts')
  })
})

// AJV parity: each fixture is validated against BOTH the Zod runtime schema and
// the generated JSON Schema (via AJV); both must agree on accept/reject for every
// input. Written before the generator/schema fixes to capture divergence count.
// Regression target: zero divergences.
describe('AJV parity: Zod runtime contract vs generated JSON Schema', () => {
  type ParityFixture = { name: string; value: unknown; accepted: boolean }

  // Fixtures covering: happy paths, defaults, all three rejected refinements,
  // strict-mode unknown field. The `accepted` field is what BOTH Zod and
  // the generated JSON Schema should agree on after the fix.
  const parityFixtures: ParityFixture[] = [
    {
      name: 'valid full config accepted by both',
      value: {
        agents: {
          'correctness-reviewer': {
            model: 'openai/gpt-4',
            temperature: 0.3,
            mode: 'subagent',
          },
        },
        categories: {
          review: { model: 'anthropic/claude-3', temperature: 0.1 },
        },
        disabled_skills: ['ce:plan'],
        disabled_agents: [],
        disabled_commands: [],
        bootstrap: { enabled: true },
      },
      accepted: true,
    },
    {
      // Key divergence: Zod applies defaults so {} is valid at runtime,
      // but the generated schema used to emit required:[all 6 fields].
      name: 'minimal empty config {} (runtime defaults make it valid)',
      value: {},
      accepted: true,
    },
    {
      name: 'partial config { disabled_skills: [] } accepted',
      value: { disabled_skills: [] },
      accepted: true,
    },
    {
      // bootstrap.enabled has .default(true), so omitting it is valid.
      // Divergence: generated schema used to emit required:["enabled"].
      name: 'bootstrap: {} accepted because enabled has runtime default',
      value: {
        agents: {},
        categories: {},
        disabled_skills: [],
        disabled_agents: [],
        disabled_commands: [],
        bootstrap: {},
      },
      accepted: true,
    },
    {
      // Zod rejects via .refine(); old generated schema had no pattern so AJV accepted.
      name: 'model: "not-a-provider-format" rejected by both',
      value: { agents: { foo: { model: 'not-a-provider-format' } } },
      accepted: false,
    },
    {
      // Zod rejects via .refine(); old generated schema had no enum/pattern for color.
      name: 'color: "blue" (non-token, non-hex) rejected by both',
      value: { agents: { foo: { color: 'blue' } } },
      accepted: false,
    },
    {
      // Zod rejects via .refine(); old generated schema had no pattern for variant.
      name: 'variant: "foo bar" (whitespace) rejected by both',
      value: { agents: { foo: { variant: 'foo bar' } } },
      accepted: false,
    },
    {
      name: 'agent variant without explicit model rejected by both',
      value: { agents: { 'correctness-reviewer': { variant: 'high' } } },
      accepted: false,
    },
    {
      name: 'agent variant with explicit model accepted by both',
      value: {
        agents: {
          'correctness-reviewer': { model: 'openai/gpt-5.5', variant: 'high' },
        },
      },
      accepted: true,
    },
    {
      name: 'category variant without explicit model rejected by both',
      value: { categories: { review: { variant: 'high' } } },
      accepted: false,
    },
    {
      name: 'agent variant with model:null rejected by both',
      value: { agents: { foo: { model: null, variant: 'high' } } },
      accepted: false,
    },
    {
      name: 'category variant with model:null rejected by both',
      value: { categories: { review: { model: null, variant: 'high' } } },
      accepted: false,
    },
    {
      name: 'variant with explicit model accepted by both',
      value: {
        agents: {
          'correctness-reviewer': { model: 'openai/gpt-5.5', variant: 'high' },
        },
      },
      accepted: true,
    },
    {
      // SystematicConfigSchema uses .strict() so unknown top-level keys are rejected.
      name: 'unknown top-level field "agnts" rejected by both (strict mode)',
      value: { agnts: {} },
      accepted: false,
    },
    {
      name: '$schema valid URL accepted by both',
      value: {
        $schema:
          'https://fro.bot/systematic/schemas/v2/systematic-config.schema.json',
      },
      accepted: true,
    },
    {
      name: '$schema invalid non-URL rejected by both',
      value: { $schema: 'not-a-url' },
      accepted: false,
    },
  ]

  // Shared state initialized in beforeAll
  let zodParse: (data: unknown) => { success: boolean } = () => {
    throw new Error('zodParse not initialized')
  }
  let ajvValidate: (data: unknown) => boolean = () => {
    throw new Error('ajvValidate not initialized')
  }
  let ajvAvailable = false

  beforeAll(async () => {
    const schemaMod = await import('../../src/lib/config-schema.js')
    zodParse = (data) => schemaMod.SystematicConfigSchema.safeParse(data)

    // Narrow try/catch to ONLY the ajv import — genuinely optional dep.
    // Everything else (generateSchemaContent, JSON.parse, ajv.compile) must
    // fail loud so errors are caught as test failures, not silently skipped.
    let AjvCtor: typeof import('ajv').default | null = null
    try {
      const ajvMod = await import('ajv')
      AjvCtor = ajvMod.default
    } catch {
      // ajv is not installed — skip the parity suite
      console.warn('SKIP AJV parity tests: ajv not installed.')
    }

    if (AjvCtor) {
      const ajv = new AjvCtor({ strict: false, allowUnionTypes: true })

      try {
        const afMod = await import('ajv-formats')
        afMod.default(ajv)
      } catch {
        // ajv-formats not installed — proceed without format validation
      }

      // These MUST NOT be in a try/catch: errors here are real test failures.
      const genMod = await import('../../scripts/generate-config-schema.js')
      const schemaContent = genMod.generateSchemaContent('2.12.0')
      const schema = JSON.parse(schemaContent) as Record<string, unknown>
      const validate = ajv.compile(schema)

      ajvValidate = (data) => {
        const result = validate(data)
        return result === true
      }
      ajvAvailable = true
    }
  })

  for (const fixture of parityFixtures) {
    test(`parity: ${fixture.name}`, () => {
      if (!ajvAvailable) {
        console.warn('SKIP: ajv not available')
        return
      }

      const zodResult = zodParse(fixture.value)
      const ajvResult = ajvValidate(fixture.value)

      // Each side must match the expected outcome
      expect(zodResult.success).toBe(fixture.accepted)
      expect(ajvResult).toBe(fixture.accepted)

      // Core parity invariant: both sides must agree
      expect(zodResult.success).toBe(ajvResult)
    })
  }

  test('parity: qualified bundled agent rejects variant without explicit model', () => {
    if (!ajvAvailable) {
      console.warn('SKIP: ajv not available')
      return
    }
    const config = {
      agents: { 'review/correctness-reviewer': { variant: 'v2' } },
    }
    // Both Zod and JSON Schema must reject this
    expect(zodParse(config).success).toBe(false)
    expect(ajvValidate(config)).toBe(false)
  })

  test('parity: qualified bundled agent accepts variant with explicit model', () => {
    if (!ajvAvailable) {
      console.warn('SKIP: ajv not available')
      return
    }
    const config = {
      agents: {
        'review/correctness-reviewer': {
          variant: 'v2',
          model: 'anthropic/claude-sonnet-4',
        },
      },
    }
    expect(zodParse(config).success).toBe(true)
    expect(ajvValidate(config)).toBe(true)
  })
})

// Meta-schema smoke test: the generated JSON Schema must itself be a valid
// draft-07 schema (AJV validateSchema check).
describe('meta-schema smoke test: generated schema is valid draft-07', () => {
  let generateSchemaContentFn: (version: string) => string
  let ajvAvailable = false
  let isValidSchema = false
  let metaErrors: unknown = null

  beforeAll(async () => {
    const genMod = await import('../../scripts/generate-config-schema.js')
    generateSchemaContentFn = genMod.generateSchemaContent

    try {
      const ajvMod = await import('ajv')
      const AjvClass = ajvMod.default
      const ajv = new AjvClass({ strict: false, allowUnionTypes: true })

      try {
        const afMod = await import('ajv-formats')
        afMod.default(ajv)
      } catch {
        // proceed without format validation
      }

      const schemaContent = generateSchemaContentFn('2.12.0')
      const schema = JSON.parse(schemaContent) as Record<string, unknown>

      isValidSchema = ajv.validateSchema(schema) as boolean
      metaErrors = ajv.errors

      ajvAvailable = true
    } catch {
      ajvAvailable = false
    }
  })

  test('generated schema passes AJV meta-schema validation', () => {
    if (!ajvAvailable) {
      console.warn('SKIP: ajv not available')
      return
    }

    if (!isValidSchema) {
      console.error('Meta-schema errors:', JSON.stringify(metaErrors, null, 2))
    }
    expect(isValidSchema).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════
// Regression: schema round-trips through JSON Schema validation
// ═════════════════════════════════════════════════════════════════

describe('ajv regression: generated schema validates representative config', () => {
  let generateSchemaContentFn: (version: string) => string
  let AjvClass: typeof import('ajv').default
  let addFormats: typeof import('ajv-formats').default | null

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.js')
    generateSchemaContentFn = mod.generateSchemaContent

    try {
      const ajvMod = await import('ajv')
      AjvClass = ajvMod.default
    } catch {
      AjvClass = undefined as unknown as typeof import('ajv').default
    }

    try {
      const af = await import('ajv-formats')
      addFormats = af.default
    } catch {
      addFormats = null
    }
  })

  test('representative agent overlay validates against generated schema', () => {
    if (!AjvClass) {
      console.warn(
        'SKIP: ajv not available — install with `bun add -D ajv` to enable schema validation regression tests.',
      )
      return
    }

    const content = generateSchemaContentFn('3.0.0')
    const schema = JSON.parse(content)

    const ajv = new AjvClass({
      strict: false,
      // Allow the schema to be used standalone (no $id external ref)
      allowUnionTypes: true,
    })

    if (addFormats) {
      addFormats(ajv)
    }

    const validate = ajv.compile(schema)

    // Representative minimal config
    const validConfig = {
      agents: {
        'correctness-reviewer': {
          model: 'openai/gpt-4',
          temperature: 0.3,
          mode: 'subagent',
        },
      },
      categories: {
        review: {
          model: 'anthropic/claude-3',
          temperature: 0.1,
        },
      },
      disabled_skills: ['ce:plan'],
      disabled_agents: [],
      disabled_commands: [],
      bootstrap: {
        enabled: true,
      },
    }

    const result = validate(validConfig)
    expect(result).toBe(true)
    if (validate.errors) {
      // eslint-disable-next-line no-console
      console.error('ajv errors:', JSON.stringify(validate.errors, null, 2))
    }
    expect(validate.errors).toBeNull()
  })

  test('generated schema rejects invalid config (temperature string)', () => {
    if (!AjvClass) {
      return
    }

    const content = generateSchemaContentFn('3.0.0')
    const schema = JSON.parse(content)

    const ajv = new AjvClass({
      strict: false,
      allowUnionTypes: true,
    })

    if (addFormats) {
      addFormats(ajv)
    }

    const validate = ajv.compile(schema)

    const invalidConfig = {
      agents: {
        'correctness-reviewer': {
          temperature: 'high', // string instead of number
        },
      },
    }

    const result = validate(invalidConfig)
    expect(result).toBe(false)
    expect(validate.errors).toBeDefined()
  })
})

// ═════════════════════════════════════════════════════════════════
// discoverBundledNames — filesystem walk for bundled agent/skill names
// ═════════════════════════════════════════════════════════════════

function seedBundledFilesystem(
  root: string,
  agents: { category: string; name: string }[],
  skills: string[],
): void {
  for (const { category, name } of agents) {
    writeFile(
      root,
      `agents/${category}/${name}.md`,
      `---\nname: ${name}\ndescription: test\n---\n\nbody`,
    )
  }
  for (const name of skills) {
    writeFile(
      root,
      `skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: test\n---\n\nbody`,
    )
  }
}

describe('discoverBundledNames — filesystem walk', () => {
  let discoverFn: (rootDir: string) => { agents: string[]; skills: string[] }

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.js')
    discoverFn = mod.discoverBundledNames
  })

  test('walks the agents directory and returns sorted bundled agent names', () => {
    const tmp = makeTempRepo()
    seedBundledFilesystem(
      tmp,
      [
        { category: 'review', name: 'correctness-reviewer' },
        { category: 'design', name: 'designer' },
        { category: 'review', name: 'security-reviewer' },
      ],
      [],
    )
    const { agents } = discoverFn(tmp)
    expect(agents).toEqual([
      'correctness-reviewer',
      'designer',
      'security-reviewer',
    ])
  })

  test('walks the skills directory and returns sorted bundled skill names', () => {
    const tmp = makeTempRepo()
    seedBundledFilesystem(tmp, [], ['ce:plan', 'ce:review', 'ce:work'])
    const { skills } = discoverFn(tmp)
    expect(skills).toEqual(['ce:plan', 'ce:review', 'ce:work'])
  })

  test('returns empty arrays when directories are empty', () => {
    const tmp = makeTempRepo()
    fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'skills'), { recursive: true })
    const { agents, skills } = discoverFn(tmp)
    expect(agents).toEqual([])
    expect(skills).toEqual([])
  })

  test('returns empty arrays when directories are absent (no agents/ or skills/)', () => {
    const tmp = makeTempRepo()
    const { agents, skills } = discoverFn(tmp)
    expect(agents).toEqual([])
    expect(skills).toEqual([])
  })

  test('discovers agents in real repo and returns at least 37 names', () => {
    // Smoke check against the actual project layout — should never go below 37.
    const projectRoot = path.resolve(__dirname, '../..')
    const { agents, skills } = discoverFn(projectRoot)
    expect(agents.length).toBeGreaterThanOrEqual(37)
    expect(skills.length).toBeGreaterThanOrEqual(34)
  })
})

// ═════════════════════════════════════════════════════════════════
// generateBundledNamesContent — TS emission + sanity check
// ═════════════════════════════════════════════════════════════════

describe('generateBundledNamesContent — sanity check + emission', () => {
  let generateFn: (
    agents: string[],
    skills: string[],
    options?: {
      previousAgentCount?: number
      previousSkillCount?: number
      allowShrink?: boolean
    },
  ) => string

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.js')
    generateFn = mod.generateBundledNamesContent
  })

  test('emits BUNDLED_AGENT_NAMES and BUNDLED_SKILL_NAMES as as-const tuples', () => {
    const out = generateFn(['agent-a', 'agent-b'], ['skill-a'])
    expect(out).toContain('export const BUNDLED_AGENT_NAMES')
    expect(out).toContain('export const BUNDLED_SKILL_NAMES')
    expect(out).toContain('as const')
    expect(out).toContain("'agent-a'")
    expect(out).toContain("'agent-b'")
    expect(out).toContain("'skill-a'")
  })

  test('emits header comment marking the file as generated', () => {
    const out = generateFn(['a'], ['b'])
    // Header must indicate generated-by-script and discourage hand-editing.
    expect(out).toMatch(/generated|DO NOT EDIT/i)
    expect(out).toContain('generate-config-schema.ts')
  })

  test('produces byte-identical output on consecutive calls with same input', () => {
    const a = generateFn(['x', 'y'], ['z'])
    const b = generateFn(['x', 'y'], ['z'])
    expect(a).toBe(b)
  })

  test('aborts when discovered agents is empty', () => {
    expect(() => generateFn([], ['skill-a'])).toThrow(/empty/i)
  })

  test('aborts when discovered skills is empty', () => {
    expect(() => generateFn(['agent-a'], [])).toThrow(/empty/i)
  })

  test('aborts when agent count shrinks from previous committed count', () => {
    expect(() =>
      generateFn(['agent-a'], ['skill-a', 'skill-b'], {
        previousAgentCount: 5,
        previousSkillCount: 2,
      }),
    ).toThrow(/shrink|allow-shrink/i)
  })

  test('aborts when skill count shrinks from previous committed count', () => {
    expect(() =>
      generateFn(['agent-a', 'agent-b'], ['skill-a'], {
        previousAgentCount: 2,
        previousSkillCount: 5,
      }),
    ).toThrow(/shrink|allow-shrink/i)
  })

  test('partial-discovery (significantly reduced count) is caught by shrink check', () => {
    // Simulates filesystem-permission failure, truncated walk, or symlink issue
    // that returns only some of the expected names.
    expect(() =>
      generateFn(
        ['agent-a', 'agent-b'], // discovered: 2
        ['skill-a', 'skill-b'],
        { previousAgentCount: 51, previousSkillCount: 45 }, // expected: 51 + 45
      ),
    ).toThrow(/shrink|allow-shrink/i)
  })

  test('--allow-shrink override permits a smaller bundled-name set', () => {
    expect(() =>
      generateFn(['agent-a'], ['skill-a'], {
        previousAgentCount: 5,
        previousSkillCount: 2,
        allowShrink: true,
      }),
    ).not.toThrow()
  })

  test('first-run exemption: no previous count → no shrink check (only empty-discovery enforced)', () => {
    // previousAgentCount / previousSkillCount are undefined when the file doesn't exist.
    expect(() => generateFn(['a'], ['b'])).not.toThrow()
  })

  test('first-run exemption still rejects empty discovery', () => {
    // Even on first run, an empty set is a real generator bug, not "no previous baseline".
    expect(() => generateFn([], [])).toThrow(/empty/i)
  })

  test('growth (more bundled names than previous) is always allowed', () => {
    expect(() =>
      generateFn(['a', 'b', 'c'], ['x', 'y'], {
        previousAgentCount: 2,
        previousSkillCount: 1,
      }),
    ).not.toThrow()
  })

  test('exact same count as previous (no shrink, no growth) is allowed', () => {
    expect(() =>
      generateFn(['a', 'b'], ['x', 'y'], {
        previousAgentCount: 2,
        previousSkillCount: 2,
      }),
    ).not.toThrow()
  })

  test('emitted content survives biome format with no formatting changes', () => {
    const content = generateFn(['agent-a', 'agent-b'], ['skill-a', 'skill-b'])
    const formatted = execSync(
      'bun biome format --stdin-file-path=src/lib/bundled-names.ts',
      {
        input: content,
        encoding: 'utf-8',
        cwd: path.resolve(__dirname, '../..'),
      },
    )
    expect(formatted).toBe(content)
  })
})

// ── Parity: --check path vs write path ───────────────────────────────────────
// Regression guard: the two call sites in generate-config-schema.ts that call
// generateBundledNamesContent must pass the same option shape so that the drift
// check (--check) and the write path (main) produce byte-identical output.
describe('--check path and write path produce byte-identical bundled-names content', () => {
  const PROJECT_ROOT = path.resolve(__dirname, '../..')

  let discoverFn: (rootDir: string) => {
    agents: string[]
    agentQualifiedIds: string[]
    skills: string[]
  }
  let generateFn: (
    agents: string[],
    skills: string[],
    opts?: { agentQualifiedIds?: string[] },
  ) => string
  let readCommittedFn: (rootDir: string) => {
    previousAgentCount: number
    previousSkillCount: number
  }

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.js')
    discoverFn = mod.discoverBundledNames
    generateFn = mod.generateBundledNamesContent
    readCommittedFn = mod.readCommittedBundledNamesCounts
  })

  test('check-path content matches committed bundled-names.ts', () => {
    const { agents, skills, agentQualifiedIds } = discoverFn(PROJECT_ROOT)
    const previous = readCommittedFn(PROJECT_ROOT)

    const checkContent = generateFn(agents, skills, {
      ...previous,
      agentQualifiedIds,
    })

    const onDisk = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src/lib/bundled-names.ts'),
      'utf-8',
    )

    expect(checkContent).toBe(onDisk)
  })
})

// readCommittedBundledNamesCounts — regression guard for quote-agnostic regex
// The countEntries regex must match Biome-formatted double-quoted entries.
// A single-quote-only regex returns 0 for every entry, making the shrink
// guard silently dead (every run looks like a first-run with no baseline).
describe('readCommittedBundledNamesCounts — double-quoted entry parsing', () => {
  let readCommittedFn: (rootDir: string) => {
    previousAgentCount?: number
    previousSkillCount?: number
  }

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.js')
    readCommittedFn = mod.readCommittedBundledNamesCounts
  })

  test('counts double-quoted entries (Biome output format) correctly', () => {
    const tmp = makeTempRepo()
    // Write a fake bundled-names.ts with double-quoted entries — the format
    // Biome actually emits. A single-quote-only regex would return 0 here.
    writeFile(
      tmp,
      'src/lib/bundled-names.ts',
      [
        'export const BUNDLED_AGENT_NAMES = [',
        '  "agent-a",',
        '  "agent-b",',
        '  "agent-c",',
        '] as const',
        '',
        'export const BUNDLED_SKILL_NAMES = [',
        '  "skill-x",',
        '  "skill-y",',
        '] as const',
      ].join('\n'),
    )

    const result = readCommittedFn(tmp)
    expect(result.previousAgentCount).toBe(3)
    expect(result.previousSkillCount).toBe(2)
  })
})

describe('createSystematicConfigSchema — generator integration', () => {
  // Verifies that the factory correctly reflects custom name sets, which is the
  // property that makes the cache-bust workaround unnecessary: the generator
  // passes fresh discovery results directly to the factory rather than relying
  // on a re-imported module to pick up a freshly written bundled-names.ts.
  test('factory schema accepts only the names passed to it, not the committed bundled set', async () => {
    const { createSystematicConfigSchema } = await import(
      '../../src/lib/config-schema.js'
    )
    const customSchema = createSystematicConfigSchema({
      agentNames: ['custom-agent'],
      qualifiedAgentIds: ['custom/custom-agent'],
      skillNames: ['custom-skill'],
    })
    // Custom names are accepted
    expect(
      customSchema.safeParse({ agents: { 'custom-agent': {} } }).success,
    ).toBe(true)
    expect(
      customSchema.safeParse({ disabled_skills: ['custom-skill'] }).success,
    ).toBe(true)
    // Committed bundled names are rejected (they're not in this factory call)
    expect(
      customSchema.safeParse({ agents: { 'correctness-reviewer': {} } })
        .success,
    ).toBe(false)
    expect(
      customSchema.safeParse({ disabled_skills: ['ce:plan'] }).success,
    ).toBe(false)
  })
})
