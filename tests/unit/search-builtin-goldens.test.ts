import { afterAll, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  defaultExternalResolver,
  runSearch,
  type SearchOptions,
} from '../../src/lib/search-core.js'
import { MAX_FILE_BYTES } from '../../src/lib/search-corpus.js'
import { resolveExternalSources } from '../../src/lib/search-external-sources.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

// Byte-exact goldens for every built-in search path: the four kinds, `all`,
// the default (`solution`) request, and the request errors. They were recorded
// from the code as it stood before external sources, and they compare exact
// bytes with no normalization. A later unit that changes built-in output fails
// here; the one expected change was the bad-kind error text, which now lists
// `external` and was re-recorded on purpose (seven error cases).
//
// The second block replays every case with an external source active for the
// project (AE11): built-in output must not move, and a built-in request must
// never reach the external resolver.
//
// To re-record after a deliberate change:
//   RECORD_BUILTIN_GOLDENS=1 bun test tests/unit/search-builtin-goldens.test.ts
//   bunx biome check --write tests/fixtures/search-builtin-goldens.json
// then review the fixture diff. Recording never runs by default.

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const FIXTURES = path.join(ROOT_DIR, 'tests/fixtures')
const CORPUS = path.join(FIXTURES, 'search-corpus')
const GOLDEN_FILE = path.join(FIXTURES, 'search-builtin-goldens.json')
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const NUL = String.fromCharCode(0x00)

type ProjectName =
  | 'lifecycle'
  | 'past-work'
  | 'hostile'
  | 'kinds-lifecycle'
  | 'everything'
  | 'hostile-generated'
  | 'long-hits'
  | 'bare'
  | 'empty-dirs'

/** A request as a host sends it: JSON-safe, so the golden file can store it. */
type RecordedRequest = Readonly<Record<string, unknown>> & { query: unknown }

interface GoldenCase {
  readonly id: string
  readonly project: ProjectName
  readonly request: RecordedRequest
}

interface Golden extends GoldenCase {
  readonly ok: boolean
  readonly text: string
  readonly warnings: readonly string[]
}

const temp = createTempDirTracker()
afterAll(() => temp.cleanup())

function newRoot(): string {
  const root = temp.track(
    fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'search-builtin-golden-')),
    ),
  )
  fs.mkdirSync(path.join(root, '.git'))
  return root
}

function put(root: string, relative: string, content: string): void {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function copyFixture(
  root: string,
  name: 'lifecycle' | 'past-work' | 'hostile',
): void {
  fs.cpSync(path.join(CORPUS, name), root, { recursive: true })
}

/** Plans, brainstorms and ideation notes that carry every lifecycle shape the non-solution kinds support. */
function writeKindsLifecycle(root: string): void {
  put(
    root,
    'docs/plans/2026-01-01-001-feat-quartz-old-plan.md',
    '---\ntitle: "feat: Quartz rollout, first draft"\nstatus: superseded\nsuperseded_by: docs/plans/2026-02-01-002-feat-quartz-new-plan.md\n---\n\nQuartz rollout first draft.\n',
  )
  put(
    root,
    'docs/plans/2026-02-01-002-feat-quartz-new-plan.md',
    '---\ntitle: "feat: Quartz rollout"\nstatus: active\n---\n\nQuartz rollout, the replacement plan.\n',
  )
  put(
    root,
    'docs/plans/2026-03-01-003-feat-quartz-stale-plan.md',
    '---\ntitle: "feat: Quartz stale plan"\nstatus: " Stale "\nstale_reason: The queue it relied on was removed.\n---\n\nQuartz stale plan body.\n',
  )
  put(
    root,
    'docs/plans/2026-03-02-004-feat-quartz-cross-plan.md',
    '---\ntitle: "feat: Quartz moved to a brainstorm"\nstatus: Superseded\nsuperseded_by: docs/brainstorms/2026-03-02-quartz-requirements.md\n---\n\nQuartz cross-kind plan body.\n',
  )
  put(
    root,
    'docs/plans/2026-03-03-005-feat-quartz-dangling-plan.md',
    '---\ntitle: "feat: Quartz dangling"\nstatus: superseded\nsuperseded_by: docs/plans/2026-99-99-missing.md\n---\n\nQuartz dangling plan body.\n',
  )
  put(
    root,
    'docs/plans/2026-03-04-006-feat-quartz-loop-a-plan.md',
    '---\ntitle: "feat: Quartz loop A"\nstatus: superseded\nsuperseded_by: docs/plans/2026-03-05-007-feat-quartz-loop-b-plan.md\n---\n\nQuartz loop A body.\n',
  )
  put(
    root,
    'docs/plans/2026-03-05-007-feat-quartz-loop-b-plan.md',
    '---\ntitle: "feat: Quartz loop B"\nstatus: superseded\nsuperseded_by: docs/plans/2026-03-04-006-feat-quartz-loop-a-plan.md\n---\n\nQuartz loop B body.\n',
  )
  put(
    root,
    'docs/plans/2026-03-06-008-feat-quartz-no-status-plan.md',
    '---\ntitle: "feat: Quartz without a status"\n---\n\nQuartz no-status plan body.\n',
  )
  put(
    root,
    'docs/brainstorms/2026-03-02-quartz-requirements.md',
    '---\ntopic: Quartz requirements\nstatus: accepted\n---\n\nQuartz requirements body.\n',
  )
  put(
    root,
    'docs/brainstorms/2026-03-03-quartz-old-requirements.md',
    '---\ntopic: Quartz old requirements\nstatus: superseded\nsuperseded_by: docs/brainstorms/2026-03-02-quartz-requirements.md\n---\n\nQuartz old requirements body.\n',
  )
  put(
    root,
    'docs/brainstorms/2026-03-04-quartz-to-ideation-requirements.md',
    '---\ntopic: Quartz folded into ideation\nstatus: superseded\nsuperseded_by: docs/ideation/2026-03-04-quartz-survey.md\n---\n\nQuartz folded brainstorm body.\n',
  )
  put(
    root,
    'docs/ideation/2026-03-04-quartz-survey.md',
    '---\ntopic: Quartz survey\nstatus: open\n---\n\nQuartz survey ideation body.\n',
  )
  put(
    root,
    'docs/ideation/2026-03-05-quartz-stale-survey.md',
    '---\ntopic: Quartz stale survey\nstatus: stale\n---\n\nQuartz stale ideation body.\n',
  )
}

/** Control characters, oversized files, symlinks and malformed frontmatter, built on disk. */
function writeHostileGenerated(root: string): void {
  const outside = temp.track(
    fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'search-builtin-outside-')),
    ),
  )
  put(
    outside,
    'target.md',
    '---\ntitle: Outside file\n---\n\nneedle outside secret\n',
  )
  put(
    outside,
    'dir/inner.md',
    '---\ntitle: Outside directory file\n---\n\nneedle outside secret\n',
  )
  put(
    outside,
    'brainstorms/escaped.md',
    '---\ntopic: Escaped brainstorm\n---\n\nneedle outside secret\n',
  )

  const solutions = 'docs/solutions'
  put(
    root,
    `${solutions}/real.md`,
    '---\ntitle: Real survivor\ntags:\n  - hostile\n---\n\nneedle survivor body.\n',
  )
  put(
    root,
    `${solutions}/evil${ESC}[31m-name${ESC}]52;c;QUJD${BEL}.md`,
    `---\ntitle: Evil ${ESC}[1mtitle\ntags:\n  - "t${ESC}]52;c;WFla${BEL}ag"\nmodule: "mod${ESC}[0mule"\n---\n\nneedle line one ${ESC}]52;c;SGVsbG8=${BEL} needle after osc\n`,
  )
  put(
    root,
    `${solutions}/control-body.md`,
    `---\ntitle: Control body\n---\n\nneedle ${NUL}nul ${ESC}[2Jclear \u0085c1 \u202eRTL \u200bzero-width \u2028line-sep tail\n`,
  )
  put(
    root,
    `${solutions}/bad${ESC}[2Jyaml.md`,
    '---\ntitle: [unterminated\n---\nbody needle\n',
  )
  put(
    root,
    `${solutions}/unterminated.md`,
    '---\ntitle: Never closed\n\nneedle body without a closing fence\n',
  )
  put(
    root,
    `${solutions}/crlf.md`,
    '---\r\ntitle: Windows line endings\r\ntags:\r\n  - crlf\r\n---\r\n\r\nneedle crlf body\r\n',
  )
  put(
    root,
    `${solutions}/bom.md`,
    '\ufeff---\ntitle: Byte order mark\n---\n\nneedle bom body\n',
  )
  const head = '---\ntitle: Oversized\n---\n\nneedle bulky '
  put(
    root,
    `${solutions}/oversized.md`,
    head + 'x'.repeat(MAX_FILE_BYTES + 1 - head.length),
  )
  fs.symlinkSync(
    path.join(outside, 'target.md'),
    path.join(root, `${solutions}/linked.md`),
  )
  fs.symlinkSync(
    path.join(root, `${solutions}/real.md`),
    path.join(root, `${solutions}/alias.md`),
  )
  fs.symlinkSync(
    path.join(outside, 'dir'),
    path.join(root, `${solutions}/linked-dir`),
  )
  fs.symlinkSync(
    path.join(root, 'missing-target.md'),
    path.join(root, `${solutions}/dangling.md`),
  )

  put(
    root,
    'docs/plans/2026-10-01-001-feat-hostile-plan.md',
    '---\ntitle: "feat: Hostile plan"\nstatus: active\n---\n\nneedle plan survivor.\n',
  )
  put(
    root,
    'docs/plans/2026-10-02-002-feat-oversized-plan.md',
    head + 'y'.repeat(MAX_FILE_BYTES + 1 - head.length),
  )
  put(
    root,
    'docs/plans/2026-10-03-003-feat-broken-plan.md',
    '---\ntitle: {\n---\nneedle\n',
  )
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.symlinkSync(
    path.join(outside, 'brainstorms'),
    path.join(root, 'docs/brainstorms'),
  )
  put(
    root,
    'docs/ideation/2026-10-01-hostile-ideation.md',
    '---\ntopic: Hostile ideation\n---\n\nneedle ideation survivor.\n',
  )
}

/** Twenty long documents per kind, so the 16 KiB output cap and its marker apply. */
function writeLongHits(root: string): void {
  const long = (label: string, i: number) =>
    `---\ntitle: ${'é'.repeat(200)}${label}${i}\nmodule: ${'m'.repeat(200)}\ntags: [${Array.from({ length: 12 }, (_, t) => `${'t'.repeat(80)}${t}`).join(', ')}]\n---\n\nneedle ${'ü'.repeat(500)}\n`
  for (let i = 0; i < 20; i++) {
    const n = String(i).padStart(2, '0')
    put(root, `docs/solutions/doc-${n}.md`, long('s', i))
    put(root, `docs/plans/2026-10-01-${n}-feat-doc.md`, long('p', i))
    put(
      root,
      `docs/brainstorms/2026-10-01-doc-${n}-requirements.md`,
      long('b', i),
    )
    put(root, `docs/ideation/2026-10-01-doc-${n}.md`, long('i', i))
  }
}

const projects = new Map<ProjectName, string>()

function projectRoot(name: ProjectName): string {
  const existing = projects.get(name)
  if (existing !== undefined) return existing
  const root = newRoot()
  switch (name) {
    case 'lifecycle':
    case 'past-work':
    case 'hostile':
      copyFixture(root, name)
      break
    case 'kinds-lifecycle':
      writeKindsLifecycle(root)
      break
    case 'everything':
      copyFixture(root, 'lifecycle')
      copyFixture(root, 'past-work')
      copyFixture(root, 'hostile')
      writeKindsLifecycle(root)
      break
    case 'hostile-generated':
      writeHostileGenerated(root)
      break
    case 'long-hits':
      writeLongHits(root)
      break
    case 'bare':
      break
    case 'empty-dirs':
      for (const dir of ['solutions', 'plans', 'brainstorms', 'ideation']) {
        fs.mkdirSync(path.join(root, 'docs', dir), { recursive: true })
      }
      put(root, 'docs/solutions/README.md', '# Index\n')
      put(root, 'docs/plans/_archived/old.md', '---\ntitle: Old\n---\n')
      break
  }
  projects.set(name, root)
  return root
}

const KIND_SWEEP = [
  undefined,
  'solution',
  'plan',
  'brainstorm',
  'ideation',
  'all',
] as const

function kindLabel(kind: string | undefined): string {
  return kind ?? 'default'
}

function sweep(
  project: ProjectName,
  slug: string,
  query: string,
  kinds: ReadonlyArray<string | undefined> = KIND_SWEEP,
  limit?: number,
): GoldenCase[] {
  return kinds.map((kind) => ({
    id: `${project}/${kindLabel(kind)}/${slug}`,
    project,
    request: {
      query,
      ...(kind === undefined ? {} : { kind }),
      ...(limit === undefined ? {} : { limit }),
    },
  }))
}

interface LabelledQuery {
  readonly id: string
  readonly query: string
  readonly target_kind: string
}

/**
 * The 16 past-work queries are labelled against this repository's own docs, so
 * over the fixture corpus most return no hit. Pinning them still records the
 * empty-result, summary and notes text of a real-world query for each kind.
 */
function pastWorkQueryCases(): GoldenCase[] {
  const file: { queries: LabelledQuery[] } = JSON.parse(
    fs.readFileSync(
      path.join(FIXTURES, 'search-past-work-queries.json'),
      'utf8',
    ),
  )
  return file.queries.map((entry) => ({
    id: `past-work-queries/${entry.id}`,
    project: 'everything',
    request: {
      query: entry.query,
      kind: entry.target_kind === 'any' ? 'all' : entry.target_kind,
    },
  }))
}

function errorCases(): GoldenCase[] {
  const bare = (id: string, request: RecordedRequest): GoldenCase => ({
    id: `errors/${id}`,
    project: 'bare',
    request,
  })
  return [
    bare('query-empty', { query: '' }),
    bare('query-blank', { query: '   \n\t' }),
    bare('query-number', { query: 42 }),
    bare('query-null', { query: null }),
    bare('query-too-long', { query: 'a'.repeat(2001) }),
    bare('query-at-limit', { query: 'a'.repeat(2000) }),
    bare('limit-zero', { query: 'alpha', limit: 0 }),
    bare('limit-over', { query: 'alpha', limit: 21 }),
    bare('limit-negative', { query: 'alpha', limit: -1 }),
    bare('limit-fraction', { query: 'alpha', limit: 1.5 }),
    bare('limit-string', { query: 'alpha', limit: '3' }),
    bare('limit-null', { query: 'alpha', limit: null }),
    bare('kind-unknown', { query: 'alpha', kind: 'bogus' }),
    bare('kind-uppercase', { query: 'alpha', kind: 'ALL' }),
    bare('kind-number', { query: 'alpha', kind: 42 }),
    bare('kind-null', { query: 'alpha', kind: null }),
    bare('kind-empty', { query: 'alpha', kind: '' }),
    bare('kind-prototype-key', { query: 'alpha', kind: 'toString' }),
    // The query is checked before the kind, and the kind before the limit.
    bare('query-before-kind', { query: '', kind: 'bogus', limit: 0 }),
    bare('kind-before-limit', { query: 'alpha', kind: 'bogus', limit: 0 }),
    bare('limit-min', { query: 'alpha', limit: 1 }),
    bare('limit-max', { query: 'alpha', limit: 20 }),
  ]
}

function buildCases(): GoldenCase[] {
  const sixtyFiveTerms = Array.from({ length: 65 }, (_, i) => `term${i}`).join(
    ' ',
  )
  return [
    // The solution lifecycle fixture, under every selector.
    ...sweep(
      'lifecycle',
      'lifecycle-fixture',
      'lifecycle-fixture',
      KIND_SWEEP,
      20,
    ),
    ...sweep('lifecycle', 'stale', 'stale'),
    ...sweep('lifecycle', 'chain-merge', 'chain merge'),
    // The plan, brainstorm and ideation fixtures.
    ...sweep('past-work', 'alpha-rollout', 'alpha rollout quarantine'),
    ...sweep('past-work', 'foo', 'foo'),
    ...sweep('past-work', 'caching', 'caching ideas'),
    ...sweep('past-work', 'requirements-body', 'requirements body'),
    ...sweep('past-work', 'repair', 'beta repair', KIND_SWEEP, 1),
    ...sweep('past-work', 'archived-and-readme', 'retired readme index'),
    ...sweep('past-work', 'unmatched', 'zzzzunmatched'),
    // Malformed frontmatter fixtures.
    ...sweep('hostile', 'survives', 'body survives cyclic alias nested'),
    ...sweep(
      'hostile',
      'frontmatter-warning',
      'frontmatter scalar unterminated',
    ),
    // Lifecycle shapes in the non-solution kinds.
    ...sweep('kinds-lifecycle', 'quartz', 'quartz', KIND_SWEEP, 20),
    ...sweep('kinds-lifecycle', 'quartz-limit-2', 'quartz', KIND_SWEEP, 2),
    ...sweep('kinds-lifecycle', 'stale', 'stale quartz survey'),
    // All four fixtures in one project.
    ...sweep(
      'everything',
      'lifecycle-fixture',
      'lifecycle-fixture',
      KIND_SWEEP,
      20,
    ),
    ...sweep('everything', 'quartz', 'quartz', KIND_SWEEP, 20),
    ...sweep('everything', 'alpha-rollout', 'alpha rollout quarantine'),
    ...sweep('everything', 'body', 'body'),
    ...sweep('everything', 'query-cut', sixtyFiveTerms, ['all']),
    // Hostile content built on disk.
    ...sweep('hostile-generated', 'needle', 'needle survivor', KIND_SWEEP, 20),
    ...sweep('hostile-generated', 'bulky', 'bulky oversized'),
    ...sweep(
      'hostile-generated',
      'hostile-query',
      `needle ${ESC}[31mquery ${BEL}`,
      [undefined, 'all'],
    ),
    // The 16 KiB output cap.
    ...sweep('long-hits', 'needle', 'needle', KIND_SWEEP, 20),
    // Missing and empty directories.
    ...sweep('bare', 'alpha', 'alpha'),
    ...sweep('empty-dirs', 'alpha', 'alpha'),
    ...pastWorkQueryCases(),
    ...errorCases(),
  ]
}

const CASES = buildCases()

async function runCase(entry: GoldenCase): Promise<Golden> {
  const response = await runSearch(
    { ...entry.request },
    { startDir: projectRoot(entry.project) },
  )
  return {
    ...entry,
    ok: response.ok,
    text: response.text,
    warnings:
      response.ok && response.selector === 'builtin'
        ? response.result.warnings
        : [],
  }
}

if (process.env.RECORD_BUILTIN_GOLDENS === '1') {
  const recorded: Golden[] = []
  for (const entry of CASES) recorded.push(await runCase(entry))
  fs.writeFileSync(GOLDEN_FILE, `${JSON.stringify(recorded, null, 2)}\n`)
}

const goldens: readonly Golden[] = JSON.parse(
  fs.readFileSync(GOLDEN_FILE, 'utf8'),
)
const goldenById = new Map(goldens.map((golden) => [golden.id, golden]))

// A fixture emptied of cases would register no per-case test and pass.
const EXPECTED_CASE_COUNT = 185

describe('built-in search output is unchanged', () => {
  it('records the expected number of cases', () => {
    expect(CASES).toHaveLength(EXPECTED_CASE_COUNT)
    expect(goldens).toHaveLength(EXPECTED_CASE_COUNT)
  })

  it('records exactly the cases defined here, with unique ids', () => {
    expect(new Set(CASES.map((entry) => entry.id)).size).toBe(CASES.length)
    expect(goldens.map((golden) => golden.id)).toEqual(
      CASES.map((entry) => entry.id),
    )
  })

  it('covers every selector with a hit and with no hit', () => {
    for (const kind of [
      'default',
      'solution',
      'plan',
      'brainstorm',
      'ideation',
      'all',
    ]) {
      const forKind = goldens.filter((golden) =>
        golden.id.split('/').includes(kind),
      )
      expect(forKind.some((golden) => golden.text.includes('\n1. docs/'))).toBe(
        true,
      )
    }
  })

  for (const entry of CASES) {
    it(`${entry.id} reproduces its recorded text and warnings byte for byte`, async () => {
      const recorded = goldenById.get(entry.id)
      if (recorded === undefined) throw new Error('no recorded output')
      expect(recorded.project).toBe(entry.project)
      expect(recorded.request).toEqual(entry.request)
      const actual = await runCase(entry)
      expect(actual.ok).toBe(recorded.ok)
      expect(actual.text).toBe(recorded.text)
      expect(actual.warnings).toEqual(recorded.warnings)
    })
  }
})

// AE11: the same cases with an external source active for the project.
describe('built-in search output is unchanged with external sources active', () => {
  const home = temp.track(
    fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'search-golden-home-')),
    ),
  )
  const external = temp.track(
    fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'search-golden-ext-')),
    ),
  )
  put(
    external,
    'needle.md',
    '---\ntitle: External needle quartz alpha lifecycle\n---\n\nneedle quartz alpha lifecycle-fixture external body.\n',
  )
  const configOptions = { homeDir: home, customConfigDir: null } as const

  /** Map the source to `root` in the user config, so it is active for that project. */
  function activate(root: string): void {
    const dir = path.join(home, '.config/opencode')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'systematic.json'),
      JSON.stringify({
        search: {
          sources: [
            {
              name: 'ext',
              format: 'markdown',
              roots: [external],
              projects: [root],
            },
          ],
        },
      }),
    )
  }

  it('really has the source active for a project', () => {
    const root = projectRoot('bare')
    activate(root)
    const { sources } = resolveExternalSources({
      startDir: root,
      configOptions,
    })
    expect(sources.map((source) => source.name)).toEqual(['ext'])
  })

  for (const entry of CASES) {
    it(`${entry.id} still reproduces its recorded text and never reaches the external resolver`, async () => {
      const recorded = goldenById.get(entry.id)
      if (recorded === undefined) throw new Error('no recorded output')
      const root = projectRoot(entry.project)
      activate(root)
      let resolverCalls = 0
      const options: SearchOptions = {
        startDir: root,
        configOptions,
        externalResolver: (input) => {
          resolverCalls += 1
          return defaultExternalResolver(input)
        },
      }
      const response = await runSearch({ ...entry.request }, options)
      expect(response.ok).toBe(recorded.ok)
      expect(response.text).toBe(recorded.text)
      expect(
        response.ok && response.selector === 'builtin'
          ? response.result.warnings
          : [],
      ).toEqual(recorded.warnings)
      expect(resolverCalls).toBe(0)
    })
  }
})
