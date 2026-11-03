/**
 * Timing harness for the external-sources measurement gate (KTD22, U6). Not a
 * CI test: run it by hand, record the numbers in the PR notes.
 *
 *   bun tests/manual/search-external-timing.ts
 *   bun tests/manual/search-external-timing.ts --warm 40 --cold 10 --json
 *   bun tests/manual/search-external-timing.ts --markdown-only   # the U6 stores alone
 *
 * It runs the built-in `plan` kind and `kind: "external"` on the same machine
 * in the same run, interleaved so drift hits both alike, and reports p50 and
 * p95 for:
 *
 * - warm: a persistent host, `runSearch` called in process after warm-up;
 * - cold: a fresh process per call, for the built `systematic-search` bin under
 *   real Node and for the built `systematic search` CLI under Bun. "Cold" means
 *   a new process, not an empty disk cache: the OS page cache stays warm.
 *
 * Budgets (KTD22) are ratios, not absolute times: external p95 at or under 2x
 * the built-in `plan` p95, warm and cold.
 *
 * Safety. The store clones are read-only inputs and are never written. All
 * config lives in a throwaway temp directory: a temp home, a temp project with
 * a `.git` directory, and a temp user config that maps the stores to that
 * project. The real user config is never read or written (the child processes
 * run with `HOME` set to the temp home and `OPENCODE_CONFIG_DIR` removed).
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildSearchBundle,
  CLAUDE_CODE_SEARCH_BIN,
  generatePluginFiles,
  writePluginFiles,
} from '../../scripts/build-claude-code-plugin.js'
import { runSearch } from '../../src/lib/search-core.js'
import { NODE_BIN } from '../helpers/real-node.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const GITHUB_ROOT = path.join(os.homedir(), 'src/github.com')

type StoreFormat = 'markdown' | 'deciduous'

interface Store {
  readonly name: string
  readonly format: StoreFormat
  readonly root: string
}

/**
 * The Markdown stores U6 measures plus the Deciduous sync folder U7 adds
 * (read-only: the harness never writes into it). `--markdown-only` drops the
 * Deciduous store to reproduce the U6 numbers.
 */
const ALL_STORES: readonly Store[] = [
  {
    name: 'agent-rfcs',
    format: 'markdown',
    root: path.join(GITHUB_ROOT, 'fro-bot/agent/RFCs'),
  },
  {
    name: 'agent-decisions',
    format: 'markdown',
    root: path.join(GITHUB_ROOT, 'fro-bot/agent/docs/decisions'),
  },
  {
    name: 'agent-wiki',
    format: 'markdown',
    root: path.join(GITHUB_ROOT, 'fro-bot/agent/docs/wiki'),
  },
  {
    name: 'github-wiki',
    format: 'markdown',
    root: path.join(GITHUB_ROOT, 'fro-bot/.github/knowledge/wiki'),
  },
  {
    name: 'infra-runbooks',
    format: 'markdown',
    root: path.join(GITHUB_ROOT, 'marcusrbrown/infra/docs/runbooks'),
  },
  {
    name: 'sparkle-decisions',
    format: 'deciduous',
    root: path.join(GITHUB_ROOT, 'marcusrbrown/sparkle/.deciduous/sync'),
  },
]

/** Realistic past-work queries; each should hit both the plans and the stores. */
const QUERIES: readonly string[] = [
  'retry backoff timeout',
  'rollback decision',
  'worktree branch cleanup',
  'schema migration compatibility',
]

type Selector = 'plan' | 'external'
const SELECTORS: readonly Selector[] = ['plan', 'external']

interface Options {
  readonly warm: number
  readonly cold: number
  readonly json: boolean
  readonly markdownOnly: boolean
}

function parseOptions(argv: readonly string[]): Options {
  const read = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag)
    if (index === -1) return fallback
    const value = Number(argv[index + 1])
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${flag} needs a positive integer`)
    }
    return value
  }
  return {
    warm: read('--warm', 25),
    cold: read('--cold', 8),
    json: argv.includes('--json'),
    markdownOnly: argv.includes('--markdown-only'),
  }
}

// --- store inventory -----------------------------------------------------------

interface StoreSize {
  readonly name: string
  readonly format: StoreFormat
  readonly root: string
  readonly exists: boolean
  readonly files: number
  readonly bytes: number
}

function inventory(
  root: string,
  extension = '.md',
): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && entry.name.endsWith(extension)) {
        files += 1
        bytes += fs.statSync(full).size
      }
    }
  }
  visit(root)
  return { files, bytes }
}

function measureStores(stores: readonly Store[]): StoreSize[] {
  return stores.map((store) => {
    const exists =
      fs.existsSync(store.root) && fs.statSync(store.root).isDirectory()
    return {
      ...store,
      exists,
      ...(exists
        ? inventory(store.root, store.format === 'deciduous' ? '.json' : '.md')
        : { files: 0, bytes: 0 }),
    }
  })
}

// --- statistics ----------------------------------------------------------------

/** Nearest-rank percentile of a non-empty sample. */
function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1] ?? Number.NaN
}

interface Summary {
  readonly n: number
  readonly p50: number
  readonly p95: number
}

function summarize(samples: readonly number[]): Summary {
  return {
    n: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
  }
}

// --- isolated environment ------------------------------------------------------

interface Env {
  readonly dir: string
  readonly home: string
  readonly project: string
}

/** A temp home, a temp project and a user config mapping every store to that project. */
function makeEnv(stores: readonly StoreSize[]): Env {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'search-external-timing-')),
  )
  const home = path.join(dir, 'home')
  const project = path.join(dir, 'project')
  fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true })
  fs.mkdirSync(path.join(project, '.git'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.config/opencode/systematic.json'),
    JSON.stringify({
      search: {
        sources: stores.map((store) => ({
          name: store.name,
          format: store.format,
          roots: [store.root],
          projects: [project],
        })),
      },
    }),
  )
  return { dir, home, project }
}

// --- warm ----------------------------------------------------------------------

async function measureWarm(
  env: Env,
  iterations: number,
): Promise<Record<Selector, number[]>> {
  const startDirs: Record<Selector, string> = {
    plan: ROOT_DIR,
    external: env.project,
  }
  const configOptions = { homeDir: env.home, customConfigDir: null }
  const samples: Record<Selector, number[]> = { plan: [], external: [] }

  const call = async (selector: Selector, query: string): Promise<number> => {
    const started = performance.now()
    const response = await runSearch(
      { query, kind: selector },
      { startDir: startDirs[selector], configOptions },
    )
    const elapsed = performance.now() - started
    if (!response.ok) throw new Error(`warm ${selector}: ${response.text}`)
    return elapsed
  }

  // Warm-up: JIT, module init and the page cache. Not counted.
  for (const query of QUERIES) {
    for (const selector of SELECTORS) await call(selector, query)
  }
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const query of QUERIES) {
      for (const selector of SELECTORS) {
        samples[selector].push(await call(selector, query))
      }
    }
  }
  return samples
}

// --- cold ----------------------------------------------------------------------

interface ColdTarget {
  readonly label: string
  /** The argv for one call. */
  command(selector: Selector, query: string): readonly [string, string[]]
}

function buildBin(dir: string): Promise<string> {
  return (async () => {
    const outDir = path.join(dir, 'bin-plugin')
    const { bundle } = await buildSearchBundle(ROOT_DIR)
    const files = generatePluginFiles(
      ROOT_DIR,
      Buffer.from('placeholder validator bundle'),
      bundle,
    )
    writePluginFiles(
      new Map(
        [...files].filter(([rel]) => rel === `bin/${CLAUDE_CODE_SEARCH_BIN}`),
      ),
      outDir,
    )
    return path.join(outDir, 'bin', CLAUDE_CODE_SEARCH_BIN)
  })()
}

/** `systematic` bundled into a temp directory, so `dist/` is never touched. */
function buildCli(dir: string): string {
  const outDir = path.join(dir, 'cli')
  const result = spawnSync(
    'bun',
    [
      'build',
      path.join(ROOT_DIR, 'src/cli.ts'),
      '--outdir',
      outDir,
      '--target',
      'bun',
    ],
    { cwd: ROOT_DIR, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`bun build of the CLI failed: ${result.stderr}`)
  }
  return path.join(outDir, 'cli.js')
}

function coldEnv(env: Env): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) clean[key] = value
  }
  clean.HOME = env.home
  clean.USERPROFILE = env.home
  delete clean.OPENCODE_CONFIG_DIR
  delete clean.XDG_CONFIG_HOME
  return clean
}

function measureCold(
  target: ColdTarget,
  env: Env,
  stores: readonly StoreSize[],
  iterations: number,
): Record<Selector, number[]> {
  const samples: Record<Selector, number[]> = { plan: [], external: [] }
  const startDirs: Record<Selector, string> = {
    plan: ROOT_DIR,
    external: env.project,
  }
  const childEnv = coldEnv(env)

  const call = (selector: Selector, query: string): number => {
    const [command, args] = target.command(selector, query)
    const started = performance.now()
    const result = spawnSync(command, args, {
      cwd: startDirs[selector],
      env: childEnv,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const elapsed = performance.now() - started
    if (result.status !== 0) {
      throw new Error(
        `cold ${target.label} ${selector} exited ${result.status}: ${result.stderr.slice(0, 300)}`,
      )
    }
    if (selector === 'external') {
      for (const store of stores) {
        if (!result.stdout.includes(store.name)) {
          throw new Error(
            `cold ${target.label} external output lacks source ${store.name}`,
          )
        }
      }
    } else if (!result.stdout.includes('Corpus: docs/plans')) {
      throw new Error(`cold ${target.label} plan output lacks its header`)
    }
    return elapsed
  }

  // One uncounted pair so the first spawn does not pay a one-time cost.
  for (const selector of SELECTORS) call(selector, QUERIES[0] ?? '')
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const query of QUERIES) {
      for (const selector of SELECTORS) {
        samples[selector].push(call(selector, query))
      }
    }
  }
  return samples
}

// --- report --------------------------------------------------------------------

interface Row {
  readonly label: string
  readonly plan: Summary
  readonly external: Summary
}

function ratio(external: number, plan: number): number {
  return external / plan
}

function fixed(value: number): string {
  return value.toFixed(1)
}

function verdict(r: number): string {
  return r <= 2 ? 'within budget' : 'OVER the 2x budget'
}

function printReport(
  stores: readonly StoreSize[],
  rows: readonly Row[],
  options: Options,
): void {
  const planInventory = inventory(path.join(ROOT_DIR, 'docs/plans'))
  const lines: string[] = [
    '# External sources timing (KTD22 gate)',
    '',
    `Date: ${new Date().toISOString()}`,
    `Machine: ${os.cpus()[0]?.model ?? 'unknown cpu'} x${os.cpus().length}, ${os.platform()} ${os.release()}`,
    `Runtimes: bun ${Bun.version}, node ${spawnSync(NODE_BIN, ['--version'], { encoding: 'utf8' }).stdout.trim()}`,
    `Samples: warm ${options.warm} iterations x ${QUERIES.length} queries per selector; cold ${options.cold} iterations x ${QUERIES.length} queries per selector, per surface`,
    '',
    'Stores read by `external` (Deciduous counts the `.json` files under the sync folder):',
  ]
  for (const store of stores) {
    lines.push(
      `  ${store.name} [${store.format}]: ${store.files} files, ${(store.bytes / 1024).toFixed(0)} KiB  ${store.root}`,
    )
  }
  const totalBytes = stores.reduce((sum, store) => sum + store.bytes, 0)
  const totalFiles = stores.reduce((sum, store) => sum + store.files, 0)
  lines.push(
    `  total: ${totalFiles} files, ${(totalBytes / 1024).toFixed(0)} KiB`,
    `Built-in \`plan\` corpus: ${planInventory.files} files, ${(planInventory.bytes / 1024).toFixed(0)} KiB  (${path.join(ROOT_DIR, 'docs/plans')})`,
    '',
    'Queries:',
    ...QUERIES.map((query) => `  ${query}`),
    '',
    'All times are wall-clock milliseconds.',
    '',
    '| Scenario | plan p50 | plan p95 | external p50 | external p95 | p50 ratio | p95 ratio | p95 verdict |',
    '|---|---|---|---|---|---|---|---|',
  )
  for (const row of rows) {
    const p95 = ratio(row.external.p95, row.plan.p95)
    lines.push(
      `| ${row.label} | ${fixed(row.plan.p50)} | ${fixed(row.plan.p95)} | ${fixed(row.external.p50)} | ${fixed(row.external.p95)} | ${ratio(row.external.p50, row.plan.p50).toFixed(2)}x | ${p95.toFixed(2)}x | ${verdict(p95)} |`,
    )
  }
  console.log(lines.join('\n'))
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const stores = measureStores(
    options.markdownOnly
      ? ALL_STORES.filter((store) => store.format === 'markdown')
      : ALL_STORES,
  )
  const missing = stores.filter((store) => !store.exists)
  if (missing.length > 0) {
    for (const store of missing) {
      console.error(`MISSING store: ${store.name} at ${store.root}`)
    }
    process.exitCode = 1
    return
  }

  const env = makeEnv(stores)
  try {
    const rows: Row[] = []

    const warm = await measureWarm(env, options.warm)
    rows.push({
      label: 'warm, in-process runSearch',
      plan: summarize(warm.plan),
      external: summarize(warm.external),
    })

    const bin = await buildBin(env.dir)
    const binTarget: ColdTarget = {
      label: 'bin',
      command: (selector, query) => [
        NODE_BIN,
        [bin, query, '--kind', selector, '--limit', '8'],
      ],
    }
    const bunBin = spawnSync('bun', ['--version'], { encoding: 'utf8' })
    if (bunBin.status !== 0) throw new Error('bun is required for the CLI row')
    const cli = buildCli(env.dir)
    const cliTarget: ColdTarget = {
      label: 'cli',
      command: (selector, query) => [
        'bun',
        [cli, 'search', query, '--kind', selector, '--limit', '8'],
      ],
    }

    const coldBin = measureCold(binTarget, env, stores, options.cold)
    rows.push({
      label: 'cold, built bin under Node',
      plan: summarize(coldBin.plan),
      external: summarize(coldBin.external),
    })
    const coldCli = measureCold(cliTarget, env, stores, options.cold)
    rows.push({
      label: 'cold, built CLI under Bun',
      plan: summarize(coldCli.plan),
      external: summarize(coldCli.external),
    })

    if (options.json) console.log(JSON.stringify({ stores, rows }, null, 2))
    else printReport(stores, rows, options)
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
