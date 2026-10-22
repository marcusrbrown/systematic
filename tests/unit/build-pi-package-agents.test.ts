import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildPiPackageAgents,
  PI_PACKAGE_AGENTS_DIR,
  runBuildPiPackageAgents,
} from '../../scripts/build-pi-package-agents.js'
import { generateAll } from '../../src/lib/pi-subagents-personas.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const FIXTURE_DIR = path.join(
  ROOT_DIR,
  'tests',
  'fixtures',
  'pi-subagents-personas',
)
const ONE_MEGABYTE = 1024 * 1024

const tempDirs: string[] = []

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-pi-agents-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** The files the default render writes: the same rule the export uses. */
function expectedFiles(): Map<string, string> {
  const files = new Map<string, string>()
  for (const entry of generateAll(ROOT_DIR)) {
    if (entry.status === 'excluded-critical' || !entry.content) continue
    files.set(entry.filename, entry.content)
  }
  return files
}

function listDir(dir: string): string[] {
  return fs.readdirSync(dir).sort()
}

describe('build-pi-package-agents', () => {
  test('writes exactly the default render set and nothing else', () => {
    const outDir = path.join(mkTmp(), 'agents')

    const exitCode = runBuildPiPackageAgents({ repoRoot: ROOT_DIR, outDir })

    expect(exitCode).toBe(0)
    const expected = expectedFiles()
    expect(expected.size).toBeGreaterThan(0)
    expect(listDir(outDir)).toEqual([...expected.keys()].sort())
  })

  test('every packaged file is byte-equal to the committed fixture', () => {
    const outDir = path.join(mkTmp(), 'agents')
    runBuildPiPackageAgents({ repoRoot: ROOT_DIR, outDir })

    for (const [filename, content] of expectedFiles()) {
      const packaged = fs.readFileSync(path.join(outDir, filename))
      const fixture = fs.readFileSync(path.join(FIXTURE_DIR, filename))
      expect(packaged.equals(fixture)).toBe(true)
      expect(packaged.toString('utf-8')).toBe(content)
    }
  })

  test('writes no manifest, timestamp or lock file next to the personas', () => {
    const outDir = path.join(mkTmp(), 'agents')
    runBuildPiPackageAgents({ repoRoot: ROOT_DIR, outDir })

    expect(listDir(outDir).every((name) => name.endsWith('.md'))).toBe(true)
  })

  test('a second run produces identical bytes', () => {
    const base = mkTmp()
    const first = path.join(base, 'first')
    const second = path.join(base, 'second')
    runBuildPiPackageAgents({ repoRoot: ROOT_DIR, outDir: first })
    runBuildPiPackageAgents({ repoRoot: ROOT_DIR, outDir: second })

    expect(listDir(second)).toEqual(listDir(first))
    for (const name of listDir(first)) {
      expect(
        fs
          .readFileSync(path.join(first, name))
          .equals(fs.readFileSync(path.join(second, name))),
      ).toBe(true)
    }
  })

  test('a stale extra file in the target is removed', () => {
    const outDir = path.join(mkTmp(), 'agents')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'systematic-stale-leftover.md'), 'old')
    fs.writeFileSync(path.join(outDir, 'notes.txt'), 'old')

    const exitCode = runBuildPiPackageAgents({ repoRoot: ROOT_DIR, outDir })

    expect(exitCode).toBe(0)
    expect(
      fs.existsSync(path.join(outDir, 'systematic-stale-leftover.md')),
    ).toBe(false)
    expect(fs.existsSync(path.join(outDir, 'notes.txt'))).toBe(false)
    expect(listDir(outDir)).toEqual([...expectedFiles().keys()].sort())
  })

  test('every packaged file has description frontmatter, is under 1 MB and has no colon in its name', () => {
    const outDir = path.join(mkTmp(), 'agents')
    runBuildPiPackageAgents({ repoRoot: ROOT_DIR, outDir })

    for (const name of listDir(outDir)) {
      expect(name).not.toContain(':')
      const bytes = fs.readFileSync(path.join(outDir, name))
      expect(bytes.length).toBeLessThan(ONE_MEGABYTE)
      const text = bytes.toString('utf-8')
      expect(text.startsWith('---\n')).toBe(true)
      const frontmatter = text.slice(4, text.indexOf('\n---', 4))
      expect(frontmatter).toMatch(/^description:/m)
    }
  })

  test('the default output directory is the one package.json declares', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'),
    ) as { pi?: { subagents?: { agents?: string[] } } }

    expect(pkg.pi?.subagents?.agents).toEqual([
      `./${path.relative(ROOT_DIR, PI_PACKAGE_AGENTS_DIR).split(path.sep).join('/')}`,
    ])
  })

  test('a generator that throws exits non-zero and leaves no directory claiming success', () => {
    const outDir = path.join(mkTmp(), 'agents')
    const errors: string[] = []

    const exitCode = runBuildPiPackageAgents({
      repoRoot: ROOT_DIR,
      outDir,
      generate: () => {
        throw new Error('injected generation failure')
      },
      onError: (message) => errors.push(message),
    })

    expect(exitCode).not.toBe(0)
    expect(errors.join('\n')).toContain('injected generation failure')
    expect(fs.existsSync(outDir)).toBe(false)
    expect(listDir(path.dirname(outDir))).toEqual([])
  })

  test('a failed run leaves a previous complete directory as it was, with no temporary sibling', () => {
    const base = mkTmp()
    const outDir = path.join(base, 'agents')
    runBuildPiPackageAgents({ repoRoot: ROOT_DIR, outDir })
    const before = listDir(outDir)

    const exitCode = runBuildPiPackageAgents({
      repoRoot: ROOT_DIR,
      outDir,
      generate: () => {
        throw new Error('second run fails')
      },
      onError: () => {},
    })

    expect(exitCode).not.toBe(0)
    expect(listDir(outDir)).toEqual(before)
    expect(listDir(base)).toEqual(['agents'])
  })

  test('a write that fails part-way removes the staging directory and keeps the previous directory', () => {
    const base = mkTmp()
    const outDir = path.join(base, 'agents')
    runBuildPiPackageAgents({ repoRoot: ROOT_DIR, outDir })
    const before = listDir(outDir)
    const [first] = generateAll(ROOT_DIR)
    if (!first) throw new Error('generateAll returned nothing')

    const exitCode = runBuildPiPackageAgents({
      repoRoot: ROOT_DIR,
      outDir,
      // The second entry names a missing subdirectory, so its write fails after
      // the first file is already staged.
      generate: () => [first, { ...first, filename: 'missing-dir/x.md' }],
      onError: () => {},
    })

    expect(exitCode).not.toBe(0)
    expect(listDir(outDir)).toEqual(before)
    expect(listDir(base)).toEqual(['agents'])
  })

  test('a filename containing a colon fails the build and writes nothing', () => {
    const outDir = path.join(mkTmp(), 'agents')
    const errors: string[] = []

    const exitCode = runBuildPiPackageAgents({
      repoRoot: ROOT_DIR,
      outDir,
      generate: () => [
        {
          filename: 'systematic-bad:name.md',
          content: '---\ndescription: x\n---\n',
          status: 'exported',
          hash: 'x',
          sourceRelPath: 'agents/x.md',
          warnings: [],
        } as unknown as ReturnType<typeof generateAll>[number],
      ],
      onError: (message) => errors.push(message),
    })

    expect(exitCode).not.toBe(0)
    expect(errors.join('\n')).toContain('systematic-bad:name.md')
    expect(fs.existsSync(outDir)).toBe(false)
  })

  test('entries excluded for critical coupling or without content are not written', () => {
    const outDir = path.join(mkTmp(), 'agents')
    const [first] = generateAll(ROOT_DIR)
    if (!first) throw new Error('generateAll returned nothing')

    const exitCode = runBuildPiPackageAgents({
      repoRoot: ROOT_DIR,
      outDir,
      generate: () => [
        first,
        {
          ...first,
          filename: 'systematic-excluded.md',
          status: 'excluded-critical',
        },
        { ...first, filename: 'systematic-empty.md', content: undefined },
      ],
    })

    expect(exitCode).toBe(0)
    expect(listDir(outDir)).toEqual([first.filename])
  })

  test('buildPiPackageAgents reports the files it wrote', () => {
    const outDir = path.join(mkTmp(), 'agents')

    const written = buildPiPackageAgents({ repoRoot: ROOT_DIR, outDir })

    expect(written.sort()).toEqual([...expectedFiles().keys()].sort())
  })

  test('running the script as a command writes the directory it was asked for', () => {
    const outDir = path.join(mkTmp(), 'agents')

    const result = Bun.spawnSync(
      ['bun', 'scripts/build-pi-package-agents.ts', '--out', outDir],
      { cwd: ROOT_DIR, timeout: 60_000 },
    )

    expect(result.exitCode).toBe(0)
    expect(listDir(outDir)).toEqual([...expectedFiles().keys()].sort())
  })
})
