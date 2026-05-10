import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')

// ── Fixture helpers ─────────────────────────────────────────────

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

// ── Assertion helpers ───────────────────────────────────────────

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
    const mod = await import('../../scripts/generate-config-schema.ts')
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
    const mod = await import('../../scripts/generate-config-schema.ts')
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

  test('resolves from git tag in a real git repo', () => {
    // Use the real repo — we know git tag v2.11.0 exists
    const result = resolveVersionFn(null, REPO_ROOT)
    expect(result).toBe('2.11.0')
  })
})

// ═════════════════════════════════════════════════════════════════
// generateSchemaContent — output shape tests
// ═════════════════════════════════════════════════════════════════

describe('generateSchemaContent', () => {
  let generateSchemaContentFn: (version: string) => string

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.ts')
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
// Integration: generate+write all three files
// ═════════════════════════════════════════════════════════════════

describe('generateAndWrite — three-file output', () => {
  let generateAndWriteFn: (
    content: string,
    version: string,
    rootDir: string,
  ) => string[]

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.ts')
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

    const v3Content = fs.readFileSync(path.join(tmp, v3Path!), 'utf-8')
    const latestContent = fs.readFileSync(path.join(tmp, latestPath!), 'utf-8')
    const distContent = fs.readFileSync(path.join(tmp, distPath!), 'utf-8')

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
    const mod = await import('../../scripts/generate-config-schema.ts')
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
  let checkSchemaFilesFn: (
    rootDir: string,
    explicitVersion?: string | null,
  ) => { ok: boolean; message: string }

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.ts')
    generateAndWriteFn = mod.generateAndWrite
    generateSchemaContentFn = mod.generateSchemaContent
    checkSchemaFilesFn = mod.checkSchemaFiles
  })

  test('happy path: all files up to date — returns ok', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '3.0.0')

    // Run generator to produce clean state
    const content = generateSchemaContentFn('3.0.0')
    generateAndWriteFn(content, '3.0.0', tmp)

    const result = checkSchemaFilesFn(tmp, '3.0.0')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('up to date')
  })

  test('detects hand-edit to one file — returns !ok with diff message', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '3.0.0')

    const content = generateSchemaContentFn('3.0.0')
    generateAndWriteFn(content, '3.0.0', tmp)

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
})

// ═════════════════════════════════════════════════════════════════
// Regression: schema round-trips through JSON Schema validation
// ═════════════════════════════════════════════════════════════════

describe('ajv regression: generated schema validates representative config', () => {
  let generateSchemaContentFn: (version: string) => string
  let AjvClass: typeof import('ajv').default
  let addFormats: typeof import('ajv-formats').default | null

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.ts')
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
        explorer: {
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
        explorer: {
          temperature: 'high', // string instead of number
        },
      },
    }

    const result = validate(invalidConfig)
    expect(result).toBe(false)
    expect(validate.errors).toBeDefined()
  })
})
