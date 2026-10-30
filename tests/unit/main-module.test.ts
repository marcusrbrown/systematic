import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMainModule } from '../../src/lib/main-module.js'
import { NODE_BIN } from '../helpers/real-node.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const MAIN_MODULE_SOURCE = path.join(ROOT_DIR, 'src/lib/main-module.ts')

const temp = createTempDirTracker()
afterEach(() => temp.cleanup())

function makeDir(): string {
  return temp.track(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'main-module-'))),
  )
}

describe('isMainModule', () => {
  it('is true when argv[1] names the module', () => {
    const dir = makeDir()
    const file = path.join(dir, 'entry.mjs')
    fs.writeFileSync(file, '')
    expect(isMainModule(pathToFileURL(file).href, ['node', file])).toBe(true)
  })

  it('is false when argv[1] names a different file', () => {
    const dir = makeDir()
    const file = path.join(dir, 'entry.mjs')
    const other = path.join(dir, 'other.mjs')
    fs.writeFileSync(file, '')
    fs.writeFileSync(other, '')
    expect(isMainModule(pathToFileURL(file).href, ['node', other])).toBe(false)
  })

  it('is true when argv[1] reaches the module through a symlink', () => {
    const dir = makeDir()
    const file = path.join(dir, 'entry.mjs')
    const link = path.join(dir, 'link.mjs')
    fs.writeFileSync(file, '')
    fs.symlinkSync(file, link)
    expect(isMainModule(pathToFileURL(file).href, ['node', link])).toBe(true)
  })

  it('is true when argv[1] is a relative path', () => {
    const dir = makeDir()
    const file = path.join(dir, 'entry.mjs')
    fs.writeFileSync(file, '')
    const relative = path.relative(process.cwd(), file)
    expect(path.isAbsolute(relative)).toBe(false)
    expect(isMainModule(pathToFileURL(file).href, ['node', relative])).toBe(
      true,
    )
  })

  it('is false when argv has no entry', () => {
    const dir = makeDir()
    const file = path.join(dir, 'entry.mjs')
    fs.writeFileSync(file, '')
    expect(isMainModule(pathToFileURL(file).href, ['node'])).toBe(false)
    expect(isMainModule(pathToFileURL(file).href, ['node', ''])).toBe(false)
  })

  it('is false when argv[1] does not exist', () => {
    const dir = makeDir()
    const file = path.join(dir, 'entry.mjs')
    fs.writeFileSync(file, '')
    expect(
      isMainModule(pathToFileURL(file).href, [
        'node',
        path.join(dir, 'missing.mjs'),
      ]),
    ).toBe(false)
  })

  it('is false when the module URL is not a resolvable file URL', () => {
    const dir = makeDir()
    const file = path.join(dir, 'entry.mjs')
    fs.writeFileSync(file, '')
    expect(isMainModule('https://example.com/entry.mjs', ['node', file])).toBe(
      false,
    )
    expect(isMainModule('not a url', ['node', file])).toBe(false)
    expect(
      isMainModule(pathToFileURL(path.join(dir, 'gone.mjs')).href, [
        'node',
        file,
      ]),
    ).toBe(false)
  })
})

/**
 * Runs the guard in a real process. The fixture is a Node-target bundle of a
 * one-line entry that imports the real `main-module.ts`, so the same bytes run
 * under both runtimes.
 */
describe('isMainModule in a real process', () => {
  async function buildFixture(): Promise<{ dir: string; entry: string }> {
    const dir = makeDir()
    const source = path.join(dir, 'fixture-source.ts')
    fs.writeFileSync(
      source,
      [
        `import { isMainModule } from ${JSON.stringify(MAIN_MODULE_SOURCE)}`,
        "if (isMainModule(import.meta.url)) console.log('RAN')",
        '',
      ].join('\n'),
    )
    const result = await Bun.build({
      entrypoints: [source],
      outdir: dir,
      naming: 'entry.mjs',
      target: 'node',
    })
    if (!result.success) {
      throw new Error(result.logs.map((log) => log.message).join('\n'))
    }
    return { dir, entry: path.join(dir, 'entry.mjs') }
  }

  const runtimes = [
    { name: 'node', bin: NODE_BIN },
    { name: 'bun', bin: process.execPath },
  ] as const

  for (const runtime of runtimes) {
    function run(args: string[], cwd: string): string {
      const result = spawnSync(runtime.bin, args, {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      return result.stdout
    }

    it(`fires on a direct run under ${runtime.name}`, async () => {
      const { dir, entry } = await buildFixture()
      expect(run([entry], dir)).toBe('RAN\n')
    }, 60_000)

    it(`fires through a symlink under ${runtime.name}`, async () => {
      const { dir, entry } = await buildFixture()
      const link = path.join(dir, 'linked.mjs')
      fs.symlinkSync(entry, link)
      expect(run([link], dir)).toBe('RAN\n')
    }, 60_000)

    it(`fires through a relative path under ${runtime.name}`, async () => {
      const { dir } = await buildFixture()
      expect(run(['./entry.mjs'], dir)).toBe('RAN\n')
      fs.mkdirSync(path.join(dir, 'sub'))
      expect(run(['../entry.mjs'], path.join(dir, 'sub'))).toBe('RAN\n')
    }, 60_000)

    it(`fires through a symlinked directory under ${runtime.name}`, async () => {
      const { dir } = await buildFixture()
      const linkedDir = path.join(dir, 'linked-dir')
      fs.symlinkSync(dir, linkedDir)
      expect(run([path.join(linkedDir, 'entry.mjs')], dir)).toBe('RAN\n')
    }, 60_000)

    it(`runs nothing when the module is imported under ${runtime.name}`, async () => {
      const { dir, entry } = await buildFixture()
      const importer = path.join(dir, 'importer.mjs')
      fs.writeFileSync(
        importer,
        `await import(${JSON.stringify(pathToFileURL(entry).href)})\nconsole.log('imported')\n`,
      )
      expect(run([importer], dir)).toBe('imported\n')
    }, 60_000)

    it(`runs nothing when there is no argv[1] under ${runtime.name}`, async () => {
      const { dir, entry } = await buildFixture()
      const args =
        runtime.name === 'node'
          ? [
              '--input-type=module',
              '-e',
              `await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log('imported')`,
            ]
          : [
              '-e',
              `await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log('imported')`,
            ]
      expect(run(args, dir)).toBe('imported\n')
    }, 60_000)
  }
})

describe('Node floor', () => {
  it('package.json engines.node equals the verified floor, 20.11', () => {
    // 20.11 is where `import.meta.dirname` (read at load time by `src/cli.ts`)
    // first exists. On 20.10 the built CLI throws ERR_INVALID_ARG_TYPE before
    // it prints anything; on 20.11 it runs, through a symlink and a relative
    // path. Nothing else under src/ needs a newer Node. Raise this only with
    // that check redone.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'),
    ) as { engines?: { node?: string } }
    expect(manifest.engines?.node).toBe('>=20.11')
  })
})
