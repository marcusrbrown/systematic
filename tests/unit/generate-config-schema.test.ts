import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  let checkSchemaFilesFn: (
    rootDir: string,
    explicitVersion?: string | null,
  ) => { ok: boolean; message: string }

  beforeAll(async () => {
    const mod = await import('../../scripts/generate-config-schema.js')
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

  test('exits 0 when latest/ is missing but v3/ and dist/ are present', () => {
    const tmp = makeTempRepo()
    writePackageJson(tmp, '3.0.0')

    // Generate and write all three (v3/, latest/, dist/)
    const content = generateSchemaContentFn('3.0.0')
    generateAndWriteFn(content, '3.0.0', tmp)

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
    // Intentionally do NOT write dist/schemas/ — this is the bug scenario

    // Must pass: dist/schemas/ is a publish-only artifact, not checked here
    const result = checkSchemaFilesFn(tmp, '3.0.0')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('up to date')
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
          explorer: {
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
      value: { agents: { foo: { variant: 'high' } } },
      accepted: false,
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
      value: { agents: { foo: { model: 'openai/gpt-5.5', variant: 'high' } } },
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
