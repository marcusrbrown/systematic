import { afterAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  bitsOf,
  computeDeterminismReport,
} from '../helpers/search-determinism-harness.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const HARNESS_PATH = path.join(
  ROOT_DIR,
  'tests/helpers/search-determinism-harness.ts',
)

const temp = createTempDirTracker()
afterAll(() => temp.cleanup())

function makeTempDir(prefix: string): string {
  return temp.track(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))),
  )
}

/**
 * Resolves a real Node binary. `process.execPath` under `bun test` is Bun, so
 * it must never launch the bundle. A missing Node is a failure, not a skip:
 * without it the test would prove nothing.
 */
function resolveNode(): string {
  const probe = spawnSync('node', ['-p', 'process.execPath'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  const nodeBin = probe.stdout?.trim() ?? ''
  if (probe.status !== 0 || nodeBin === '') {
    throw new Error(
      'a real `node` is required for the determinism test and none was found on PATH',
    )
  }
  const bunCheck = spawnSync(nodeBin, ['-p', "typeof Bun === 'undefined'"], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  if (bunCheck.status !== 0 || bunCheck.stdout.trim() !== 'true') {
    throw new Error(
      'the resolved `node` binary is Bun, not a real Node runtime',
    )
  }
  return nodeBin
}

async function buildBundle(entryDir: string): Promise<string> {
  const entry = path.join(entryDir, 'entry.ts')
  fs.writeFileSync(
    entry,
    [
      `import { computeDeterminismReport } from ${JSON.stringify(HARNESS_PATH)}`,
      'process.stdout.write(JSON.stringify(computeDeterminismReport()))',
      '',
    ].join('\n'),
  )
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'node',
    format: 'esm',
  })
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join('\n'))
  }
  const output = result.outputs[0]
  if (!output) throw new Error('the determinism bundle produced no output')
  return output.text()
}

function parseReport(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
    throw new Error('the harness did not print a JSON array of strings')
  }
  return parsed
}

describe('search determinism across runtimes', () => {
  it('bitsOf renders float64 bit patterns', () => {
    expect(bitsOf(1)).toBe('3ff0000000000000')
    expect(bitsOf(0)).toBe('0000000000000000')
    expect(bitsOf(-0)).toBe('8000000000000000')
    expect(bitsOf(1 + Number.EPSILON)).toBe('3ff0000000000001')
  })

  it('finds a real Node binary rather than skipping', () => {
    expect(resolveNode()).not.toBe('')
  })

  it('the Bun-built bundle run under Node prints the same float64 bit patterns as Bun', async () => {
    const nodeBin = resolveNode()
    const buildDir = makeTempDir('search-determinism-build-')
    const foreign = makeTempDir('search-determinism-foreign-')

    const bundle = await buildBundle(buildDir)
    const bin = path.join(foreign, 'determinism.mjs')
    fs.writeFileSync(bin, bundle)

    const run = spawnSync(nodeBin, [bin], {
      cwd: foreign,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)

    const nodeReport = parseReport(run.stdout)
    const bunReport = computeDeterminismReport()

    expect(nodeReport.length).toBe(bunReport.length)
    expect(nodeReport.length).toBeGreaterThan(4_000)
    // Name the first divergence instead of dumping two huge arrays.
    const firstDifference = bunReport.findIndex(
      (line, i) => line !== nodeReport[i],
    )
    expect(
      firstDifference === -1
        ? 'identical'
        : `line ${String(firstDifference)}: bun=${bunReport[firstDifference]} node=${nodeReport[firstDifference]}`,
    ).toBe('identical')

    // The report must contain real scores and ln values, or equality is empty.
    expect(bunReport.some((line) => line.startsWith('score '))).toBe(true)
    expect(bunReport.some((line) => line.startsWith('ln '))).toBe(true)
  }, 120_000)

  it('is repeatable within one process', () => {
    expect(computeDeterminismReport()).toEqual(computeDeterminismReport())
  })
})
