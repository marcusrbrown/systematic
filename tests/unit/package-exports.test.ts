import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  let packTempDir: string | undefined

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
    if (packTempDir) {
      fs.rmSync(packTempDir, { recursive: true, force: true })
    }
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

interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface IsolatedFixture {
  tempRoot: string
  projectDir: string
  homeDir: string
  xdgConfigHome: string
  xdgDataHome: string
  xdgCacheHome: string
  xdgStateHome: string
}

function createIsolatedFixture(): IsolatedFixture {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-pi-'))
  const projectDir = path.join(tempRoot, 'project')
  const homeDir = path.join(tempRoot, 'home')
  const xdgConfigHome = path.join(tempRoot, 'xdg-config')
  const xdgDataHome = path.join(tempRoot, 'xdg-data')
  const xdgCacheHome = path.join(tempRoot, 'xdg-cache')
  const xdgStateHome = path.join(tempRoot, 'xdg-state')

  for (const dir of [
    projectDir,
    homeDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify(
      {
        name: 'systematic-pi-smoke-fixture',
        private: true,
        type: 'module',
      },
      null,
      2,
    ),
  )

  return {
    tempRoot,
    projectDir,
    homeDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
  }
}

function runPiCommand(
  projectDir: string,
  homeDir: string,
  xdgConfigHome: string,
  xdgDataHome: string,
  xdgCacheHome: string,
  xdgStateHome: string,
  args: string[],
  input?: string,
): ProcessResult {
  const piCliPath = path.join(
    ROOT_DIR,
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'cli.js',
  )
  const result = spawnSync('node', [piCliPath, ...args], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_STATE_HOME: xdgStateHome,
      npm_config_cache: path.join(homeDir, '.npm-cache'),
      npm_config_prefix: path.join(homeDir, '.npm-prefix'),
    },
    input,
    encoding: 'utf8',
    timeout: 120_000,
  })

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  }
}

function createSmokeControlPackage(tempRoot: string): {
  tarballPath: string
  commandName: string
} {
  const packageDir = fs.mkdtempSync(path.join(tempRoot, 'pi-control-'))
  const distDir = path.join(packageDir, 'dist')
  const commandName = `pi-loader-smoke-${createHash('sha256')
    .update(packageDir)
    .digest('hex')
    .slice(0, 12)}`

  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: '@fro.bot/systematic-loader-smoke',
        version: '0.0.0',
        type: 'module',
        pi: {
          extensions: ['./dist/pi.js'],
        },
        files: ['dist'],
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(distDir, 'pi.js'),
    `export default async function registerSmokeExtension(pi) {
  pi.registerCommand(${JSON.stringify(commandName)}, {
    description: 'Test-only Pi loader smoke command',
    handler: async () => {},
  })
}
`,
  )

  const packDir = fs.mkdtempSync(path.join(tempRoot, 'pi-control-pack-'))
  const pack = spawnSync(
    'npm',
    ['pack', '--pack-destination', packDir, '--silent'],
    {
      cwd: packageDir,
      encoding: 'utf8',
      timeout: 60_000,
    },
  )
  if (pack.status !== 0) {
    throw new Error(
      `npm pack failed for smoke control package (exit ${pack.status})\n--- stdout ---\n${pack.stdout}\n--- stderr ---\n${pack.stderr}`,
    )
  }

  const tarballName = pack.stdout.trim().split('\n').at(-1)
  if (!tarballName) {
    throw new Error('smoke control package pack produced no tarball filename')
  }

  return {
    tarballPath: path.join(packDir, tarballName),
    commandName,
  }
}

describe('Pi managed-install package-loader smoke', () => {
  let packedTarballPath: string
  let packTempDir: string | undefined

  beforeAll(() => {
    const build = spawnSync('bun', ['run', 'build'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      timeout: 120_000,
    })
    if (build.status !== 0) {
      throw new Error(
        `bun run build failed (exit ${build.status})\n--- stdout ---\n${build.stdout}\n--- stderr ---\n${build.stderr}`,
      )
    }

    packTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'systematic-pack-'))
    const pack = spawnSync(
      'npm',
      ['pack', '--pack-destination', packTempDir, '--silent'],
      {
        cwd: ROOT_DIR,
        encoding: 'utf8',
        timeout: 60_000,
      },
    )
    if (pack.status !== 0) {
      if (packTempDir) {
        fs.rmSync(packTempDir, { recursive: true, force: true })
      }
      throw new Error(
        `npm pack failed (exit ${pack.status})\n--- stdout ---\n${pack.stdout}\n--- stderr ---\n${pack.stderr}`,
      )
    }

    const tarballName = pack.stdout.trim().split('\n').at(-1)
    if (!tarballName) {
      if (packTempDir) {
        fs.rmSync(packTempDir, { recursive: true, force: true })
      }
      throw new Error('npm pack produced no tarball filename')
    }

    packedTarballPath = path.join(packTempDir, tarballName)
  })

  afterAll(() => {
    if (packTempDir) {
      fs.rmSync(packTempDir, { recursive: true, force: true })
    }
  })

  test('raw tarball loads fail while npm:file installs expose the smoke command', () => {
    if (!packedTarballPath) {
      throw new Error('packTarballOnce() has not run')
    }

    const rawFixture = createIsolatedFixture()
    const managedFixture = createIsolatedFixture()
    const smokeControlRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'systematic-pi-control-'),
    )
    const smokeControl = createSmokeControlPackage(smokeControlRoot)
    try {
      const rawInstall = runPiCommand(
        rawFixture.projectDir,
        rawFixture.homeDir,
        rawFixture.xdgConfigHome,
        rawFixture.xdgDataHome,
        rawFixture.xdgCacheHome,
        rawFixture.xdgStateHome,
        ['install', packedTarballPath, '-l', '--approve'],
      )
      expect(rawInstall.exitCode).toBe(0)

      const rawRpc = runPiCommand(
        rawFixture.projectDir,
        rawFixture.homeDir,
        rawFixture.xdgConfigHome,
        rawFixture.xdgDataHome,
        rawFixture.xdgCacheHome,
        rawFixture.xdgStateHome,
        ['--mode', 'rpc', '--no-session', '--approve'],
        '{"type":"get_commands"}\n',
      )
      expect(rawRpc.exitCode).toBe(1)
      expect(rawRpc.stderr).toContain('Failed to load extension')
      expect(rawRpc.stderr).toContain(packedTarballPath)

      const installSpec = `npm:@fro.bot/systematic@file:${packedTarballPath}`

      const managedInstall = runPiCommand(
        managedFixture.projectDir,
        managedFixture.homeDir,
        managedFixture.xdgConfigHome,
        managedFixture.xdgDataHome,
        managedFixture.xdgCacheHome,
        managedFixture.xdgStateHome,
        ['install', installSpec, '-l', '--approve'],
      )
      expect(managedInstall.exitCode).toBe(0)

      const controlInstall = runPiCommand(
        managedFixture.projectDir,
        managedFixture.homeDir,
        managedFixture.xdgConfigHome,
        managedFixture.xdgDataHome,
        managedFixture.xdgCacheHome,
        managedFixture.xdgStateHome,
        [
          'install',
          `npm:@fro.bot/systematic-loader-smoke@file:${smokeControl.tarballPath}`,
          '-l',
          '--approve',
        ],
      )
      expect(controlInstall.exitCode).toBe(0)

      const rpc = runPiCommand(
        managedFixture.projectDir,
        managedFixture.homeDir,
        managedFixture.xdgConfigHome,
        managedFixture.xdgDataHome,
        managedFixture.xdgCacheHome,
        managedFixture.xdgStateHome,
        ['--mode', 'rpc', '--no-session', '--approve'],
        '{"type":"get_commands"}\n',
      )
      expect(rpc.exitCode).toBe(0)

      const responseLine = rpc.stdout
        .trim()
        .split('\n')
        .find((line) => line.includes('"command":"get_commands"'))
      expect(responseLine).toBeDefined()

      const response = JSON.parse(responseLine ?? '{}') as {
        success?: boolean
        data?: { commands?: Array<{ name?: string; source?: string }> }
      }
      expect(response.success).toBe(true)

      const command = response.data?.commands?.find(
        (entry) => entry.name === smokeControl.commandName,
      )
      expect(command).toMatchObject({
        name: smokeControl.commandName,
        source: 'extension',
      })
    } finally {
      fs.rmSync(rawFixture.tempRoot, { recursive: true, force: true })
      fs.rmSync(managedFixture.tempRoot, { recursive: true, force: true })
      fs.rmSync(smokeControlRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
