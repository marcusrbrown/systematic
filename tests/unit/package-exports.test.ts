import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const SRC_DIR = path.join(ROOT_DIR, 'src')
const DIST_DIR = path.join(ROOT_DIR, 'dist')
const DIST_INDEX = path.join(DIST_DIR, 'index.js')
const DIST_PI = path.join(DIST_DIR, 'pi.js')

interface PackageJson {
  main?: string
  exports?: Record<string, unknown>
  files?: string[]
  pi?: {
    extensions?: string[]
    skills?: string[]
  }
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

function readPackageJson(): PackageJson {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'),
  ) as PackageJson
}

describe('package.json Pi manifest', () => {
  test('declares pi.extensions pointing at dist/pi.js', () => {
    const pkg = readPackageJson()
    expect(pkg.pi?.extensions).toEqual(['./dist/pi.js'])
  })

  test('declares pi.skills pointing at ./skills', () => {
    const pkg = readPackageJson()
    expect(pkg.pi?.skills).toEqual(['./skills'])
  })

  test('main and root export stay pointed at dist/index.js (no ./pi export)', () => {
    const pkg = readPackageJson()
    expect(pkg.main).toBe('./dist/index.js')
    expect(Object.keys(pkg.exports ?? {})).toEqual(['.'])
    const dotExport = (pkg.exports as Record<string, { import?: string }>)['.']
    expect(dotExport?.import).toBe('./dist/index.js')
  })

  test('keeps skills and agents in files for packaging', () => {
    const pkg = readPackageJson()
    expect(pkg.files).toContain('skills')
    expect(pkg.files).toContain('agents')
    expect(pkg.files).toContain('dist')
  })

  test('declares @earendil-works/pi-coding-agent and typebox as optional peer deps', () => {
    const pkg = readPackageJson()
    expect(
      pkg.peerDependencies?.['@earendil-works/pi-coding-agent'],
    ).toBeDefined()
    expect(pkg.peerDependencies?.typebox).toBeDefined()
    expect(
      pkg.peerDependenciesMeta?.['@earendil-works/pi-coding-agent']?.optional,
    ).toBe(true)
    expect(pkg.peerDependenciesMeta?.typebox?.optional).toBe(true)
    expect(pkg.peerDependenciesMeta?.['@opencode-ai/plugin']?.optional).toBe(
      true,
    )
  })
})

describe('src/pi.ts entry', () => {
  test('exists', () => {
    expect(fs.existsSync(path.join(SRC_DIR, 'pi.ts'))).toBe(true)
  })

  test('default export is a function and module exports no other names', async () => {
    const piPath = path.join(SRC_DIR, 'pi.ts')
    const piModule = (await import(pathToFileURL(piPath).href)) as Record<
      string,
      unknown
    >
    expect(typeof piModule.default).toBe('function')
    expect(Object.keys(piModule).sort()).toEqual(['default'])
  })

  test('does not statically import OpenCode plugin SDK', () => {
    const source = fs.readFileSync(path.join(SRC_DIR, 'pi.ts'), 'utf8')
    expect(source).not.toContain('@opencode-ai/plugin')
  })
})

describe('build output and packaging', () => {
  let packedTarballPath: string
  let packTempDir: string

  beforeAll(() => {
    const build = Bun.spawnSync(['bun', 'run', 'build'], {
      cwd: ROOT_DIR,
      timeout: 120_000,
    })
    if (build.exitCode !== 0) {
      throw new Error(
        `bun run build failed (exit ${build.exitCode})\n${build.stderr.toString()}`,
      )
    }

    packTempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-pack-exports-'),
    )
    const pack = Bun.spawnSync(
      ['npm', 'pack', '--pack-destination', packTempDir, '--silent'],
      { cwd: ROOT_DIR, timeout: 60_000 },
    )
    if (pack.exitCode !== 0) {
      fs.rmSync(packTempDir, { recursive: true, force: true })
      throw new Error(
        `npm pack failed (exit ${pack.exitCode})\n${pack.stderr.toString()}`,
      )
    }
    const tarballName = pack.stdout.toString().trim().split('\n').at(-1)
    if (!tarballName) {
      fs.rmSync(packTempDir, { recursive: true, force: true })
      throw new Error('npm pack produced no tarball filename')
    }
    packedTarballPath = path.join(packTempDir, tarballName)
  })

  afterAll(() => {
    fs.rmSync(packTempDir, { recursive: true, force: true })
  })

  test('dist/index.js exports exactly [default]', async () => {
    const mod = (await import(pathToFileURL(DIST_INDEX).href)) as Record<
      string,
      unknown
    >
    expect(Object.keys(mod).sort()).toEqual(['default'])
    expect(typeof mod.default).toBe('function')
  })

  test('dist/pi.js default export is a function importable without OpenCode runtime values', async () => {
    const mod = (await import(pathToFileURL(DIST_PI).href)) as Record<
      string,
      unknown
    >
    expect(typeof mod.default).toBe('function')
    expect(Object.keys(mod).sort()).toEqual(['default'])
  })

  test('tarball contains dist/pi.js, dist/index.js, skills/**, agents/**', () => {
    const listing = Bun.spawnSync(['tar', 'tzf', packedTarballPath], {
      timeout: 30_000,
    })
    const entries = listing.stdout.toString().split('\n')

    expect(entries.some((e) => e === 'package/dist/index.js')).toBe(true)
    expect(entries.some((e) => e === 'package/dist/pi.js')).toBe(true)
    expect(entries.some((e) => e.startsWith('package/skills/'))).toBe(true)
    expect(entries.some((e) => e.startsWith('package/agents/'))).toBe(true)
  })

  test('pi.extensions/pi.skills manifest paths resolve inside the tarball', () => {
    const extractDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-pack-extract-'),
    )
    try {
      const extract = Bun.spawnSync(
        ['tar', 'xzf', packedTarballPath, '-C', extractDir],
        { timeout: 30_000 },
      )
      if (extract.exitCode !== 0) {
        throw new Error(`tar extraction failed: ${extract.stderr.toString()}`)
      }
      const extractedPkg = JSON.parse(
        fs.readFileSync(path.join(extractDir, 'package/package.json'), 'utf8'),
      ) as PackageJson
      for (const ext of extractedPkg.pi?.extensions ?? []) {
        expect(fs.existsSync(path.join(extractDir, 'package', ext))).toBe(true)
      }
      for (const skillDir of extractedPkg.pi?.skills ?? []) {
        expect(fs.existsSync(path.join(extractDir, 'package', skillDir))).toBe(
          true,
        )
      }
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true })
    }
  })
})
