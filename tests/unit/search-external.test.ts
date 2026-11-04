import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  loadCorpus,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_LISTED_ENTRIES,
  MAX_TOTAL_BYTES,
} from '../../src/lib/search-corpus.js'
import {
  EXTERNAL_MAX_FILE_BYTES,
  EXTERNAL_TOTAL_BUDGET_BYTES,
  loadExternalSources,
  type SourceLoad,
} from '../../src/lib/search-external.js'
import type { ActiveSource } from '../../src/lib/search-external-sources.js'
import { watchInspections } from '../helpers/watch-inspections.js'
import { cleanupTempDirs, makeDir } from './git-worktree-fixtures'

afterEach(cleanupTempDirs)

interface Env {
  /** The checkout root: a directory holding a `.git` directory. */
  readonly checkout: string
  /** A directory outside the checkout, for user roots and escapes. */
  readonly outside: string
}

function makeEnv(): Env {
  const base = fs.realpathSync(makeDir('extload-'))
  const checkout = path.join(base, 'repo')
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true })
  const outside = path.join(base, 'outside')
  fs.mkdirSync(outside, { recursive: true })
  return { checkout, outside }
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function source(
  name: string,
  roots: readonly string[],
  overrides: Partial<ActiveSource> = {},
): ActiveSource {
  return {
    name,
    format: 'markdown',
    roots,
    origin: 'user',
    exclude: [],
    ...overrides,
  }
}

function loadOne(
  env: Env,
  active: ActiveSource,
  budgetBytes?: number,
): SourceLoad {
  const [only] = loadExternalSources({
    sources: [active],
    checkoutRoot: env.checkout,
    budgetBytes,
  })
  if (only === undefined) throw new Error('no source load returned')
  return only
}

function record(load: SourceLoad, relativePath: string) {
  const found = load.records.find(
    (candidate) => candidate.path === `${load.name}/${relativePath}`,
  )
  if (found === undefined) throw new Error(`no record ${relativePath}`)
  return found
}

describe('loadExternalSources: Markdown records', () => {
  test('returns only .md files, with the source, origin and a source-prefixed path', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    write(root, 'a.md', 'text\n')
    write(root, 'notes.txt', 'ignored\n')
    write(root, 'data.json', '{}\n')
    write(root, 'sub/b.MD', 'text\n')

    const load = loadOne(env, source('wiki', [root]))

    expect(load.state).toBe('loaded')
    expect(load.records.map((r) => r.path)).toEqual([
      'wiki/a.md',
      'wiki/sub/b.MD',
    ])
    expect(load.records.every((r) => r.source === 'wiki')).toBe(true)
    expect(load.records.every((r) => r.origin === 'user')).toBe(true)
  })

  test('title is title, then the first H1, then the file name; status only when recorded', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'rfcs')
    write(
      root,
      'titled.md',
      '---\ntitle: From Frontmatter\nstatus: accepted\n---\n\n# Heading\n',
    )
    write(
      root,
      'heading.md',
      '---\nstatus: draft\n---\n\n# From Heading #\n\ntext\n',
    )
    write(root, 'plain.md', 'no heading here\n')

    const load = loadOne(env, source('rfcs', [root]))

    expect(record(load, 'titled.md')).toMatchObject({
      title: 'From Frontmatter',
      status: 'accepted',
    })
    expect(record(load, 'heading.md')).toMatchObject({
      title: 'From Heading',
      status: 'draft',
    })
    const plain = record(load, 'plain.md')
    expect(plain.title).toBe('plain')
    expect(plain.status).toBeUndefined()
    expect(plain.nodeType).toBeUndefined()
  })

  test('a runbook with an H1 and no frontmatter has a title and no status', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'runbooks')
    write(root, 'restart.md', '# Restarting the gateway\n\nStep one.\n')

    const load = loadOne(env, source('runbooks', [root]))

    const found = record(load, 'restart.md')
    expect(found.title).toBe('Restarting the gateway')
    expect(found.status).toBeUndefined()
    expect(found.body).toContain('Step one.')
  })

  test('an H1 inside a fenced code block is not a title', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'docs')
    write(root, 'fenced.md', '```sh\n# a shell comment\n```\n\n# Real Title\n')
    write(root, 'only-fenced.md', '~~~\n# not a title\n~~~\n')

    const load = loadOne(env, source('docs', [root]))

    expect(record(load, 'fenced.md').title).toBe('Real Title')
    expect(record(load, 'only-fenced.md').title).toBe('only-fenced')
  })

  test('a non-string title or status falls through without being stringified', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'docs')
    write(root, 'numbers.md', '---\ntitle: 42\nstatus: 7\n---\n\n# Real\n')
    write(root, 'lists.md', '---\ntitle: [a, b]\nstatus: {x: 1}\n---\n')
    write(root, 'blank.md', '---\ntitle: "   "\nstatus: ""\n---\n')

    const load = loadOne(env, source('docs', [root]))

    expect(record(load, 'numbers.md')).toMatchObject({ title: 'Real' })
    expect(record(load, 'numbers.md').status).toBeUndefined()
    expect(record(load, 'lists.md').title).toBe('lists')
    expect(record(load, 'lists.md').status).toBeUndefined()
    expect(record(load, 'blank.md').title).toBe('blank')
    expect(record(load, 'blank.md').status).toBeUndefined()
  })

  test('a BOM, and a closing --- with no trailing newline, still parse', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'docs')
    write(root, 'bom.md', '\uFEFF---\ntitle: With BOM\n---\n\nbody\n')
    write(root, 'nonewline.md', '---\ntitle: No Newline\nstatus: done\n---')

    const load = loadOne(env, source('docs', [root]))

    expect(record(load, 'bom.md').title).toBe('With BOM')
    expect(record(load, 'nonewline.md')).toMatchObject({
      title: 'No Newline',
      status: 'done',
    })
  })

  test('malformed YAML and non-mapping frontmatter are rejected with a bounded warning and no record', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'docs')
    write(root, 'broken.md', '---\ntitle: [unclosed\n---\n\nbody\n')
    write(root, 'list.md', '---\n- a\n- b\n---\n\nbody\n')
    write(root, 'good.md', 'fine\n')

    const load = loadOne(env, source('docs', [root]))

    expect(load.records.map((r) => r.path)).toEqual(['docs/good.md'])
    expect(load.warnings).toContain(
      'skipped docs/broken.md: invalid frontmatter',
    )
    expect(load.warnings).toContain(
      'skipped docs/list.md: frontmatter is not a mapping',
    )
  })

  test('no kind-specific excludes apply: README.md and _archived are searchable', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'docs')
    write(root, 'README.md', '# Readme\n')
    write(root, '_archived/old.md', '# Old\n')

    const load = loadOne(env, source('docs', [root]))

    expect(load.records.map((r) => r.path)).toEqual([
      'docs/README.md',
      'docs/_archived/old.md',
    ])
  })

  test('records come back in code-unit path order, identically on every call', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'docs')
    for (const name of ['b.md', 'Z.md', 'a.md', 'z/1.md', 'a/2.md']) {
      write(root, name, `# ${name}\n`)
    }

    const first = loadOne(env, source('docs', [root]))
    const second = loadOne(env, source('docs', [root]))

    expect(first.records.map((r) => r.path)).toEqual([
      'docs/Z.md',
      'docs/a.md',
      'docs/a/2.md',
      'docs/b.md',
      'docs/z/1.md',
    ])
    expect(second).toEqual(first)
  })
})

describe('loadExternalSources: caps', () => {
  test('the external per-file cap is 1 MB; built-ins stay at 256 KiB', () => {
    expect(EXTERNAL_MAX_FILE_BYTES).toBe(1024 * 1024)
    expect(MAX_FILE_BYTES).toBe(256 * 1024)
  })

  test('a 900 KB file is indexed and a 1.1 MB file is skipped with a warning', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'docs')
    write(root, 'big.md', `# Big\n${'x'.repeat(900 * 1024)}\n`)
    write(root, 'huge.md', `# Huge\n${'x'.repeat(1100 * 1024)}\n`)

    const load = loadOne(env, source('docs', [root]))

    expect(load.records.map((r) => r.path)).toEqual(['docs/big.md'])
    expect(load.warnings).toContain(
      `skipped docs/huge.md: larger than ${EXTERNAL_MAX_FILE_BYTES} bytes`,
    )
  })

  test('a 443 KB wiki-page-sized file is indexed externally but still skipped as a built-in', () => {
    const env = makeEnv()
    const page = `# Wiki page\n${'word '.repeat(88_600)}\n`
    expect(page.length).toBeGreaterThan(440_000)
    expect(page.length).toBeLessThan(450_000)
    write(env.outside, 'wiki/page.md', page)
    write(env.checkout, 'docs/solutions/page.md', page)

    const external = loadOne(
      env,
      source('wiki', [path.join(env.outside, 'wiki')]),
    )
    const builtIn = loadCorpus(env.checkout, 'solution')

    expect(external.records.map((r) => r.path)).toEqual(['wiki/page.md'])
    expect(builtIn.documents).toHaveLength(0)
    expect(builtIn.warnings).toContain(
      `skipped docs/solutions/page.md: larger than ${MAX_FILE_BYTES} bytes`,
    )
  })

  test('the file limit applies to a source, with a named warning', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'many')
    fs.mkdirSync(root, { recursive: true })
    for (let index = 0; index < MAX_FILES + 5; index++) {
      fs.writeFileSync(
        path.join(root, `f${String(index).padStart(5, '0')}.md`),
        'x\n',
      )
    }

    const load = loadOne(env, source('many', [root]))

    expect(load.records).toHaveLength(MAX_FILES)
    expect(load.warnings).toContain(
      `many: file limit of ${MAX_FILES} reached; skipped 5 files`,
    )
  })
})

describe('loadExternalSources: shared read budget', () => {
  test('the budget is 32 MB', () => {
    expect(EXTERNAL_TOTAL_BUDGET_BYTES).toBe(32 * 1024 * 1024)
  })

  test('a source whose summed sizes exceed the remaining budget is dropped whole before any file is read', () => {
    const env = makeEnv()
    const big = path.join(env.outside, 'big')
    const small = path.join(env.outside, 'small')
    write(big, 'one.md', 'x'.repeat(600))
    write(big, 'two.md', 'y'.repeat(600))
    write(small, 'tiny.md', '# Tiny\n')
    const reads: string[] = []
    const original = fs.openSync
    const spy = spyOn(fs, 'openSync').mockImplementation(((
      file: fs.PathLike,
      ...rest: unknown[]
    ) => {
      reads.push(String(file))
      return (original as (...args: unknown[]) => number)(file, ...rest)
    }) as typeof fs.openSync)

    let loads: SourceLoad[]
    try {
      loads = loadExternalSources({
        sources: [source('big', [big]), source('small', [small])],
        checkoutRoot: env.checkout,
        budgetBytes: 1000,
      })
    } finally {
      spy.mockRestore()
    }

    const [bigLoad, smallLoad] = loads
    expect(bigLoad).toMatchObject({
      name: 'big',
      state: 'dropped',
      records: [],
    })
    expect(bigLoad?.warnings.join('\n')).toContain('big')
    expect(reads.some((file) => file.startsWith(big))).toBe(false)
    expect(smallLoad?.state).toBe('loaded')
    expect(smallLoad?.records).toHaveLength(1)
  })

  test('a source that fits is read and draws on the shared budget; a later source that no longer fits is dropped and a smaller one still loads', () => {
    const env = makeEnv()
    const first = path.join(env.outside, 'first')
    const second = path.join(env.outside, 'second')
    const third = path.join(env.outside, 'third')
    write(first, 'a.md', 'a'.repeat(600))
    write(second, 'b.md', 'b'.repeat(600))
    write(third, 'c.md', 'c'.repeat(100))

    const loads = loadExternalSources({
      sources: [
        source('first', [first]),
        source('second', [second]),
        source('third', [third]),
      ],
      checkoutRoot: env.checkout,
      budgetBytes: 1000,
    })

    expect(loads.map((l) => [l.name, l.state])).toEqual([
      ['first', 'loaded'],
      ['second', 'dropped'],
      ['third', 'loaded'],
    ])
  })

  test('a file over the per-file cap is never opened, so it does not count against the budget', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'docs')
    write(root, 'huge.md', 'x'.repeat(EXTERNAL_MAX_FILE_BYTES + 1))
    write(root, 'small.md', 'tiny\n')

    const load = loadOne(env, source('docs', [root]), 1000)

    expect(load.state).toBe('loaded')
    expect(load.records.map((r) => r.path)).toEqual(['docs/small.md'])
  })

  test('the sum covers every root of a source before any root is read', () => {
    const env = makeEnv()
    const one = path.join(env.outside, 'one')
    const two = path.join(env.outside, 'two')
    write(one, 'a.md', 'a'.repeat(600))
    write(two, 'b.md', 'b'.repeat(600))

    const load = loadOne(env, source('both', [one, two]), 1000)

    expect(load.state).toBe('dropped')
    expect(load.records).toHaveLength(0)
  })
})

describe('loadExternalSources: states', () => {
  test('a format: deciduous source loads through its own reader; others still load', () => {
    const env = makeEnv()
    const graph = path.join(env.outside, 'graph')
    const wiki = path.join(env.outside, 'wiki')
    write(
      graph,
      'nodes/n1.json',
      JSON.stringify({ change_id: 'n1', node_type: 'decision', title: 'N1' }),
    )
    write(
      graph,
      'nodes/a1.json',
      JSON.stringify({ change_id: 'a1', node_type: 'action' }),
    )
    write(wiki, 'a.md', '# A\n')

    const loads = loadExternalSources({
      sources: [
        source('graph', [graph], { format: 'deciduous' }),
        source('wiki', [wiki]),
      ],
      checkoutRoot: env.checkout,
    })

    expect(loads[0]).toMatchObject({ name: 'graph', state: 'loaded' })
    expect(loads[0]?.records).toEqual([
      {
        source: 'graph',
        origin: 'user',
        path: 'graph/nodes/n1.json',
        title: 'N1',
        nodeType: 'decision',
        body: '',
      },
    ])
    expect(loads[0]?.warnings.join('\n')).not.toContain('not supported')
    expect(loads[1]?.state).toBe('loaded')
    expect(loads[1]?.records).toHaveLength(1)
  })

  test('a Deciduous source and a Markdown source share one read budget in source order', () => {
    const env = makeEnv()
    const graph = path.join(env.outside, 'graph')
    const wiki = path.join(env.outside, 'wiki')
    write(
      graph,
      'nodes/n1.json',
      JSON.stringify({ change_id: 'n1', node_type: 'decision' }),
    )
    write(wiki, 'a.md', `# A\n${'x'.repeat(500)}\n`)
    const graphBytes = fs.statSync(path.join(graph, 'nodes/n1.json')).size

    const loads = loadExternalSources({
      sources: [
        source('graph', [graph], { format: 'deciduous' }),
        source('wiki', [wiki]),
      ],
      checkoutRoot: env.checkout,
      budgetBytes: graphBytes + 10,
    })

    expect(loads[0]?.state).toBe('loaded')
    expect(loads[1]?.state).toBe('dropped')
  })

  test('a missing root is missing and a root with no readable records is empty; others still load', () => {
    const env = makeEnv()
    const emptyRoot = path.join(env.outside, 'empty')
    const noMarkdown = path.join(env.outside, 'no-markdown')
    const good = path.join(env.outside, 'good')
    fs.mkdirSync(emptyRoot, { recursive: true })
    write(noMarkdown, 'a.txt', 'x\n')
    write(good, 'a.md', '# A\n')

    const loads = loadExternalSources({
      sources: [
        source('absent', [path.join(env.outside, 'nowhere')]),
        source('empty', [emptyRoot]),
        source('nomd', [noMarkdown]),
        source('good', [good]),
      ],
      checkoutRoot: env.checkout,
    })

    expect(loads.map((l) => [l.name, l.state])).toEqual([
      ['absent', 'missing'],
      ['empty', 'empty'],
      ['nomd', 'empty'],
      ['good', 'loaded'],
    ])
    expect(loads[0]?.warnings).toEqual([])
  })

  test('a root that is a file is missing, not an error', () => {
    const env = makeEnv()
    write(env.outside, 'file.md', '# Not a directory\n')

    const load = loadOne(env, source('f', [path.join(env.outside, 'file.md')]))

    expect(load.state).toBe('missing')
  })

  test.skipIf(process.getuid?.() === 0)(
    'a root that cannot be read is unreadable, with fixed text and no error detail',
    () => {
      const env = makeEnv()
      const locked = path.join(env.outside, 'locked')
      write(locked, 'inner/a.md', '# A\n')
      fs.chmodSync(locked, 0o000)
      try {
        const load = loadOne(
          env,
          source('locked', [path.join(locked, 'inner')]),
        )
        expect(load.state).toBe('unreadable')
        expect(load.warnings).toEqual(['could not read locked; not loaded'])
      } finally {
        fs.chmodSync(locked, 0o755)
      }
    },
  )

  // Locking a directory makes `realpath` fail on macOS but not on Linux, so a
  // chmod alone reaches the listing on one platform and the probe on the other.
  // Failing the listing directly pins the same state on both.
  test('a root that exists but cannot be listed is unreadable, with fixed text and no error detail', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    write(root, 'a.md', '# A\n')
    const realRoot = fs.realpathSync(root)
    const realOpendir = fs.opendirSync.bind(fs)
    const spy = spyOn(fs, 'opendirSync').mockImplementation(((
      target: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (String(target) === realRoot) {
        throw Object.assign(new Error('EACCES: permission denied'), {
          code: 'EACCES',
        })
      }
      return (realOpendir as (...args: unknown[]) => fs.Dir)(target, ...rest)
    }) as typeof fs.opendirSync)
    let load: SourceLoad
    try {
      load = loadOne(env, source('wiki', [root]))
    } finally {
      spy.mockRestore()
    }

    expect(load.state).toBe('unreadable')
    expect(load.records).toEqual([])
    expect(load.warnings).toEqual(['could not read wiki; not loaded'])
  })

  test('with several roots, a missing one does not hide the others', () => {
    const env = makeEnv()
    const present = path.join(env.outside, 'present')
    write(present, 'a.md', '# A\n')

    const load = loadOne(
      env,
      source('multi', [path.join(env.outside, 'nowhere'), present]),
    )

    expect(load.state).toBe('loaded')
    expect(load.records.map((r) => r.path)).toEqual(['multi/a.md'])
  })

  test('with several roots, the same relative path keeps the first root and warns', () => {
    const env = makeEnv()
    const one = path.join(env.outside, 'one')
    const two = path.join(env.outside, 'two')
    write(one, 'a.md', '# From one\n')
    write(two, 'a.md', '# From two\n')
    write(two, 'b.md', '# Only two\n')

    const load = loadOne(env, source('multi', [one, two]))

    expect(load.records.map((r) => [r.path, r.title])).toEqual([
      ['multi/a.md', 'From one'],
      ['multi/b.md', 'Only two'],
    ])
    expect(load.warnings).toContain(
      'multi: skipped 1 file whose path is already provided by an earlier root',
    )
  })

  test('input order is kept in the result', () => {
    const env = makeEnv()
    const roots = ['zeta', 'alpha', 'mid'].map((name) => {
      const root = path.join(env.outside, name)
      write(root, 'a.md', '# A\n')
      return source(name, [root])
    })

    const loads = loadExternalSources({
      sources: roots,
      checkoutRoot: env.checkout,
    })

    expect(loads.map((l) => l.name)).toEqual(['zeta', 'alpha', 'mid'])
  })
})

describe('loadExternalSources: symlinks and containment', () => {
  test('a symlinked file and a symlinked directory inside a root yield nothing and no warning names the target', () => {
    const env = makeEnv()
    const root = path.join(env.checkout, 'docs/decisions')
    write(root, 'real.md', '# Real\n')
    const secret = path.join(env.outside, 'secret-target')
    write(secret, 'leak.md', '# Leaked\n')
    fs.symlinkSync(path.join(secret, 'leak.md'), path.join(root, 'link.md'))
    fs.symlinkSync(secret, path.join(root, 'linked-dir'))

    const load = loadOne(
      env,
      source('decisions', [root], { origin: 'project' }),
    )

    expect(load.records.map((r) => r.path)).toEqual(['decisions/real.md'])
    expect(load.warnings.join('\n')).not.toContain('secret-target')
    expect(load.warnings.join('\n')).not.toContain('leak')
  })

  test('symlinks are skipped at depth in user sources too', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    write(root, 'a/b/real.md', '# Real\n')
    write(env.outside, 'elsewhere/x.md', '# X\n')
    fs.symlinkSync(
      path.join(env.outside, 'elsewhere/x.md'),
      path.join(root, 'a/b/link.md'),
    )

    const load = loadOne(env, source('wiki', [root]))

    expect(load.records.map((r) => r.path)).toEqual(['wiki/a/b/real.md'])
    expect(load.warnings).toEqual([])
  })

  test('a project root that is a symlink is dropped with a named warning', () => {
    const env = makeEnv()
    write(env.checkout, 'real/a.md', '# A\n')
    const link = path.join(env.checkout, 'docs-link')
    fs.symlinkSync(path.join(env.checkout, 'real'), link)

    const load = loadOne(env, source('linked', [link], { origin: 'project' }))

    expect(load).toMatchObject({ state: 'dropped', records: [] })
    expect(load.warnings.join('\n')).toContain('linked')
    expect(load.warnings.join('\n')).not.toContain(
      path.join(env.checkout, 'real'),
    )
  })

  test('a user root that is a symlink is followed once', () => {
    const env = makeEnv()
    const target = path.join(env.outside, 'target')
    write(target, 'a.md', '# A\n')
    const link = path.join(env.outside, 'link')
    fs.symlinkSync(target, link)

    const load = loadOne(env, source('followed', [link]))

    expect(load.state).toBe('loaded')
    expect(load.records.map((r) => r.path)).toEqual(['followed/a.md'])
  })

  test('a project root that resolves outside the checkout is dropped', () => {
    const env = makeEnv()
    write(env.outside, 'escape/a.md', '# Escaped\n')
    fs.symlinkSync(env.outside, path.join(env.checkout, 'via'))

    const viaParent = loadOne(
      env,
      source('via', [path.join(env.checkout, 'via/escape')], {
        origin: 'project',
      }),
    )
    const absolute = loadOne(
      env,
      source('abs', [path.join(env.outside, 'escape')], { origin: 'project' }),
    )

    for (const load of [viaParent, absolute]) {
      expect(load).toMatchObject({ state: 'dropped', records: [] })
      expect(load.warnings.join('\n')).toContain(load.name)
    }
  })

  test('a user root is not held to the checkout', () => {
    const env = makeEnv()
    write(env.outside, 'wiki/a.md', '# A\n')

    const load = loadOne(env, source('wiki', [path.join(env.outside, 'wiki')]))

    expect(load.state).toBe('loaded')
  })

  test('a bad project root drops the whole source, even when another root is fine', () => {
    const env = makeEnv()
    write(env.checkout, 'good/a.md', '# A\n')
    write(env.outside, 'bad/b.md', '# B\n')

    const load = loadOne(
      env,
      source(
        'mixed',
        [path.join(env.checkout, 'good'), path.join(env.outside, 'bad')],
        {
          origin: 'project',
        },
      ),
    )

    expect(load).toMatchObject({ state: 'dropped', records: [] })
  })
})

describe('loadExternalSources: bounded work', () => {
  test('a folder of many non-Markdown entries stops at the entry bound with a warning', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'assets')
    fs.mkdirSync(root, { recursive: true })
    for (let index = 0; index < MAX_LISTED_ENTRIES + 1; index++) {
      fs.closeSync(fs.openSync(path.join(root, `x${index}.png`), 'w'))
    }

    const load = loadOne(env, source('assets', [root]))

    expect(load.state).toBe('empty')
    expect(load.warnings).toContain(
      `assets: entry limit of ${MAX_LISTED_ENTRIES} reached; some entries were not examined`,
    )
  }, 30_000)

  test('a nested folder that runs the entry budget out is named once for the source', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    write(root, 'top.md', '# Top\n')
    const nested = path.join(root, 'media')
    fs.mkdirSync(nested, { recursive: true })
    for (let index = 0; index < MAX_LISTED_ENTRIES + 1; index++) {
      fs.closeSync(fs.openSync(path.join(nested, `x${index}.png`), 'w'))
    }

    const load = loadOne(env, source('wiki', [root]))

    expect(load.records.map((r) => r.path)).toEqual(['wiki/top.md'])
    expect(load.warnings).toContain(
      `wiki: entry limit of ${MAX_LISTED_ENTRIES} reached; some entries were not examined`,
    )
  }, 30_000)

  test('built-in kinds still list a directory whole: no entry bound, no listing warning', () => {
    const env = makeEnv()
    write(env.checkout, 'docs/solutions/a.md', '# A\n')

    const builtIn = loadCorpus(env.checkout, 'solution')

    expect(builtIn.documents).toHaveLength(1)
    expect(builtIn.warnings).toEqual([])
  })

  test('a file that grows past the per-file cap after discovery is rejected', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'docs')
    write(root, 'good.md', '# Good\n')
    write(root, 'grows.md', '# Grows\n')
    const target = path.join(fs.realpathSync(root), 'grows.md')
    const realOpen = fs.openSync.bind(fs)
    const spy = spyOn(fs, 'openSync').mockImplementation(((
      file: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (String(file) === target) {
        fs.appendFileSync(target, 'x'.repeat(EXTERNAL_MAX_FILE_BYTES))
      }
      return (realOpen as (...args: unknown[]) => number)(file, ...rest)
    }) as typeof fs.openSync)
    let load: SourceLoad
    try {
      load = loadOne(env, source('docs', [root]))
    } finally {
      spy.mockRestore()
    }

    expect(load.records.map((r) => r.path)).toEqual(['docs/good.md'])
    expect(load.warnings).toContain(
      `skipped docs/grows.md: larger than ${EXTERNAL_MAX_FILE_BYTES} bytes`,
    )
  })

  test('the shared budget is charged the bytes actually read, not the stat size', () => {
    const env = makeEnv()
    const grown = path.join(env.outside, 'grown')
    const later = path.join(env.outside, 'later')
    write(grown, 'a.md', 'a'.repeat(100))
    write(later, 'b.md', 'b'.repeat(500))
    const target = path.join(fs.realpathSync(grown), 'a.md')
    const realOpen = fs.openSync.bind(fs)
    const spy = spyOn(fs, 'openSync').mockImplementation(((
      file: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (String(file) === target) fs.appendFileSync(target, 'a'.repeat(500))
      return (realOpen as (...args: unknown[]) => number)(file, ...rest)
    }) as typeof fs.openSync)
    let loads: SourceLoad[]
    try {
      loads = loadExternalSources({
        sources: [source('grown', [grown]), source('later', [later])],
        checkoutRoot: env.checkout,
        // The stat size of 100 would leave room for the 500-byte later source.
        budgetBytes: 1000,
      })
    } finally {
      spy.mockRestore()
    }

    expect(loads.map((l) => [l.name, l.state])).toEqual([
      ['grown', 'loaded'],
      ['later', 'dropped'],
    ])
  })

  test('a built-in file that grows past the cap after discovery is rejected too', () => {
    const env = makeEnv()
    write(env.checkout, 'docs/solutions/good.md', '# Good\n')
    write(env.checkout, 'docs/solutions/grows.md', '# Grows\n')
    const target = path.join(
      fs.realpathSync(env.checkout),
      'docs/solutions/grows.md',
    )
    const realOpen = fs.openSync.bind(fs)
    const spy = spyOn(fs, 'openSync').mockImplementation(((
      file: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (String(file) === target) {
        fs.appendFileSync(target, 'x'.repeat(MAX_FILE_BYTES))
      }
      return (realOpen as (...args: unknown[]) => number)(file, ...rest)
    }) as typeof fs.openSync)
    let builtIn: ReturnType<typeof loadCorpus>
    try {
      builtIn = loadCorpus(env.checkout, 'solution')
    } finally {
      spy.mockRestore()
    }

    expect(builtIn.documents.map((d) => d.path)).toEqual([
      'docs/solutions/good.md',
    ])
    expect(builtIn.warnings).toContain(
      `skipped docs/solutions/grows.md: larger than ${MAX_FILE_BYTES} bytes`,
    )
  })
})

/**
 * Count the directory entries a load reads, through the directory handles it
 * opens, and the paths it opens a handle for.
 */
function watchListings() {
  const opened: string[] = []
  let entries = 0
  const realOpendir = fs.opendirSync.bind(fs)
  const spy = spyOn(fs, 'opendirSync').mockImplementation(((
    target: fs.PathLike,
    ...rest: unknown[]
  ) => {
    opened.push(String(target))
    const dir = (realOpendir as (...args: unknown[]) => fs.Dir)(target, ...rest)
    const realRead = dir.readSync.bind(dir)
    dir.readSync = () => {
      const entry = realRead()
      if (entry !== null) entries += 1
      return entry
    }
    return dir
  }) as typeof fs.opendirSync)
  return {
    opened,
    get entries() {
      return entries
    },
    stop: () => spy.mockRestore(),
  }
}

/**
 * Watch the files a load opens and the bytes it reads. A path in `grow` gets
 * that text appended just before it is opened, as a writer would between
 * discovery and the read.
 */
function watchReads(grow: Readonly<Record<string, string>> = {}) {
  const opened: string[] = []
  let bytes = 0
  const realOpen = fs.openSync.bind(fs)
  const realRead = fs.readSync.bind(fs)
  const openSpy = spyOn(fs, 'openSync').mockImplementation(((
    file: fs.PathLike,
    ...rest: unknown[]
  ) => {
    const key = String(file)
    opened.push(key)
    const extra = grow[key]
    if (extra !== undefined) fs.appendFileSync(key, extra)
    return (realOpen as (...args: unknown[]) => number)(file, ...rest)
  }) as typeof fs.openSync)
  const readSpy = spyOn(fs, 'readSync').mockImplementation(((
    ...args: Parameters<typeof fs.readSync>
  ) => {
    const count = realRead(...args)
    bytes += count
    return count
  }) as typeof fs.readSync)
  return {
    opened,
    get bytes() {
      return bytes
    },
    stop: () => {
      openSpy.mockRestore()
      readSpy.mockRestore()
    },
  }
}

describe('loadExternalSources: reads stop at the remaining allowance', () => {
  test('a file that grows past the remaining shared budget is rejected, not indexed, and nothing after it is read', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'docs')
    write(root, 'a.md', `# A\n${'a'.repeat(90)}\n`)
    write(root, 'b.md', `# B\n${'b'.repeat(90)}\n`)
    const watch = watchReads({
      [path.join(fs.realpathSync(root), 'a.md')]: 'x'.repeat(4900),
    })
    let load: SourceLoad
    try {
      load = loadOne(env, source('docs', [root]), 1000)
    } finally {
      watch.stop()
    }

    expect(load.records).toEqual([])
    expect(load.state).toBe('empty')
    // The allowance of 1,000 bytes, plus the one sentinel byte.
    expect(watch.bytes).toBeLessThanOrEqual(1001)
    expect(watch.bytes).toBeGreaterThan(0)
    expect(watch.opened.some((file) => file.endsWith('/b.md'))).toBe(false)
    expect(load.warnings).toContain(
      'docs: read budget of this call reached; skipped 2 files',
    )
  })

  test('a file that grows past the per-source text budget is rejected, not indexed, and nothing after it is read', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'big')
    // Sixteen files of 1,000,000 bytes leave 777,216 of the 16 MiB source budget.
    for (let index = 0; index < 16; index++) {
      write(
        root,
        `f${String(index).padStart(2, '0')}.md`,
        `# F${index}\n${'x'.repeat(1_000_000)}\n`,
      )
    }
    write(root, 'grows.md', '# Grows\n')
    write(root, 'later.md', '# Later\n')
    const watch = watchReads({
      [path.join(fs.realpathSync(root), 'grows.md')]: 'x'.repeat(1_000_000),
    })
    let load: SourceLoad
    try {
      load = loadOne(env, source('big', [root]))
    } finally {
      watch.stop()
    }

    expect(load.records).toHaveLength(16)
    expect(load.records.some((r) => r.path.endsWith('grows.md'))).toBe(false)
    // The 16 MiB source budget, plus the one sentinel byte.
    expect(watch.bytes).toBeLessThanOrEqual(MAX_TOTAL_BYTES + 1)
    expect(watch.opened.some((file) => file.endsWith('/later.md'))).toBe(false)
    expect(load.warnings).toContain(
      `big: text budget of ${MAX_TOTAL_BYTES} bytes reached; skipped 2 files`,
    )
  })
})

describe('loadExternalSources: one entry budget per source', () => {
  test('several directories across two roots that hold no Markdown stop at the budget, with one warning', () => {
    const env = makeEnv()
    const one = path.join(env.outside, 'one')
    const two = path.join(env.outside, 'two')
    for (const root of [one, two]) {
      for (const dir of ['d1', 'd2', 'd3']) {
        for (let index = 0; index < 40; index++) {
          write(root, `${dir}/f${index}.png`, 'x')
        }
      }
    }
    const watch = watchListings()
    let loads: SourceLoad[]
    try {
      loads = loadExternalSources({
        sources: [source('assets', [one, two])],
        checkoutRoot: env.checkout,
        entryBudget: 100,
      })
    } finally {
      watch.stop()
    }

    const [load] = loads
    expect(load?.state).toBe('empty')
    expect(load?.warnings).toEqual([
      'assets: entry limit of 100 reached; some entries were not examined',
    ])
    // The budget, plus the one read that shows a listing had more.
    expect(watch.entries).toBeLessThanOrEqual(101)
    expect(watch.entries).toBeGreaterThan(90)
    // The second root is never opened once the first has used the budget.
    expect(watch.opened.some((target) => target.includes('/two'))).toBe(false)
  })

  test('a source with room under the budget is listed whole and says nothing', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    write(root, 'a/one.md', '# One\n')
    write(root, 'b/two.md', '# Two\n')

    const [load] = loadExternalSources({
      sources: [source('wiki', [root])],
      checkoutRoot: env.checkout,
      entryBudget: 100,
    })

    expect(load?.records).toHaveLength(2)
    expect(load?.warnings).toEqual([])
  })

  test('each source gets its own budget', () => {
    const env = makeEnv()
    const one = path.join(env.outside, 'one')
    const two = path.join(env.outside, 'two')
    for (const root of [one, two]) {
      for (let index = 0; index < 30; index++) write(root, `f${index}.png`, 'x')
      write(root, 'note.md', '# Note\n')
    }

    const loads = loadExternalSources({
      sources: [source('a', [one]), source('b', [two])],
      checkoutRoot: env.checkout,
      entryBudget: 40,
    })

    expect(loads.map((l) => l.records.length)).toEqual([1, 1])
    expect(loads.flatMap((l) => l.warnings)).toEqual([])
  })
})

describe('loadExternalSources: excludes', () => {
  const paths = (load: SourceLoad) => load.records.map((r) => r.path)

  test('a bare name drops the file at any depth and the directory with its subtree', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    write(root, 'keep.md', '# Keep\n')
    write(root, 'log.md', '# Log\n')
    write(root, 'sub/log.md', '# Log\n')
    write(root, '.stryker-tmp/x.md', '# X\n')
    write(root, 'deep/.stryker-tmp/y.md', '# Y\n')

    const load = loadOne(
      env,
      source('wiki', [root], { exclude: ['log.md', '.stryker-tmp'] }),
    )

    expect(load.state).toBe('loaded')
    expect(paths(load)).toEqual(['wiki/keep.md'])
    expect(load.warnings).toEqual([])
  })

  test('a pattern with a slash is anchored at the source root', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    write(root, 'drafts/a.md', '# A\n')
    write(root, 'notes/drafts/a.md', '# B\n')
    write(root, 'drafts/x/a.md', '# C\n')

    const load = loadOne(
      env,
      source('wiki', [root], { exclude: ['drafts/*.md'] }),
    )

    expect(paths(load)).toEqual([
      'wiki/drafts/x/a.md',
      'wiki/notes/drafts/a.md',
    ])
  })

  test('an anchored pattern applies relative to each root of a source', () => {
    const env = makeEnv()
    const one = path.join(env.outside, 'one')
    const two = path.join(env.outside, 'two')
    write(one, 'drafts/a.md', '# One\n')
    write(one, 'keep.md', '# Keep\n')
    write(two, 'drafts/b.md', '# Two\n')
    write(two, 'notes/drafts/c.md', '# Three\n')

    const load = loadOne(
      env,
      source('wiki', [one, two], { exclude: ['drafts/*.md'] }),
    )

    expect(paths(load)).toEqual(['wiki/keep.md', 'wiki/notes/drafts/c.md'])
  })

  test('an excluded file is never inspected and an excluded directory is never listed or inspected', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    write(root, 'keep.md', '# Keep\n')
    write(root, 'secret.md', '# Secret\n')
    write(root, 'vendor/a.md', '# A\n')
    write(root, 'sub/vendor/b.md', '# B\n')
    write(root, 'sub/ok.md', '# Ok\n')
    const watch = watchInspections()
    let load: SourceLoad
    try {
      load = loadOne(
        env,
        source('wiki', [root], { exclude: ['secret.md', 'vendor'] }),
      )
    } finally {
      watch.stop()
    }

    expect(paths(load)).toEqual(['wiki/keep.md', 'wiki/sub/ok.md'])
    const touched = [...watch.statted, ...watch.listed]
    expect(touched.some((target) => target.includes('secret.md'))).toBe(false)
    expect(touched.some((target) => target.includes('vendor'))).toBe(false)
    expect(touched.some((target) => target.endsWith('keep.md'))).toBe(true)
  })

  test('names a pattern excludes still count against the entry budget', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    for (let index = 0; index < 30; index++) {
      write(root, `skip${index}.md`, '# Skip\n')
    }
    write(root, 'keep.md', '# Keep\n')
    const watch = watchListings()
    let loads: SourceLoad[]
    try {
      loads = loadExternalSources({
        sources: [source('wiki', [root], { exclude: ['skip*.md'] })],
        checkoutRoot: env.checkout,
        entryBudget: 10,
      })
    } finally {
      watch.stop()
    }

    expect(loads[0]?.warnings).toContain(
      'wiki: entry limit of 10 reached; some entries were not examined',
    )
    expect(watch.entries).toBeLessThanOrEqual(11)
  })

  test('an excluded file over the per-file cap raises no warning and costs no read budget', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    write(
      root,
      'huge.md',
      `# Huge\n${'x'.repeat(EXTERNAL_MAX_FILE_BYTES + 10)}`,
    )
    write(root, 'keep.md', '# Keep\n')

    const load = loadOne(env, source('wiki', [root], { exclude: ['huge.md'] }))

    expect(paths(load)).toEqual(['wiki/keep.md'])
    expect(load.warnings).toEqual([])
  })

  test('excluded files do not make a source need more of the shared read budget', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    write(root, 'big.md', `# Big\n${'x'.repeat(5000)}`)
    write(root, 'keep.md', '# Keep\n')

    const load = loadOne(
      env,
      source('wiki', [root], { exclude: ['big.md'] }),
      200,
    )

    expect(load.state).toBe('loaded')
    expect(paths(load)).toEqual(['wiki/keep.md'])
    expect(load.warnings).toEqual([])
  })

  test('excluded files do not count toward the file cap', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    fs.mkdirSync(root, { recursive: true })
    for (let index = 0; index < MAX_FILES + 5; index++) {
      fs.writeFileSync(path.join(root, `a-skip${index}.md`), '# S\n')
    }
    write(root, 'keep.md', '# Keep\n')

    const load = loadOne(
      env,
      source('wiki', [root], { exclude: ['a-skip*.md'] }),
    )

    expect(paths(load)).toEqual(['wiki/keep.md'])
    expect(load.warnings).toEqual([])
  })

  test('an empty exclude list changes nothing', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    write(root, 'log.md', '# Log\n')
    write(root, 'sub/log.md', '# Log\n')

    const load = loadOne(env, source('wiki', [root], { exclude: [] }))

    expect(paths(load)).toEqual(['wiki/log.md', 'wiki/sub/log.md'])
  })

  test('a source whose every file is excluded reports empty', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    write(root, 'a.md', '# A\n')

    const load = loadOne(env, source('wiki', [root], { exclude: ['**'] }))

    expect(load.state).toBe('empty')
  })
})

describe('loadExternalSources: symlinked ancestors of a project root', () => {
  test('a project root below a symlinked directory is dropped, even when the link stays inside the checkout', () => {
    const env = makeEnv()
    write(env.checkout, '.hidden/private/secret.md', '# Secret\n')
    fs.symlinkSync(
      path.join(env.checkout, '.hidden'),
      path.join(env.checkout, 'docs'),
    )

    const load = loadOne(
      env,
      source('docs', [path.join(env.checkout, 'docs/private')], {
        origin: 'project',
      }),
    )

    expect(load).toMatchObject({ state: 'dropped', records: [] })
    expect(load.warnings).toContain(
      'docs: a project root passes through a symlink; source dropped',
    )
  })

  test('the same layout without a symlink loads, and a user root below a symlink is followed', () => {
    const env = makeEnv()
    write(env.checkout, 'docs/private/plain.md', '# Plain\n')
    write(env.outside, 'real/inner/user.md', '# User\n')
    fs.symlinkSync(
      path.join(env.outside, 'real'),
      path.join(env.outside, 'link'),
    )

    const project = loadOne(
      env,
      source('docs', [path.join(env.checkout, 'docs/private')], {
        origin: 'project',
      }),
    )
    const user = loadOne(
      env,
      source('wiki', [path.join(env.outside, 'link/inner')]),
    )

    expect(project.records.map((r) => r.path)).toEqual(['docs/plain.md'])
    expect(user.records.map((r) => r.path)).toEqual(['wiki/user.md'])
  })
})

describe('loadExternalSources: read-only', () => {
  test('touches no process, network or write API', () => {
    const env = makeEnv()
    const root = path.join(env.outside, 'wiki')
    write(root, 'a.md', '# A\n')
    const spies = [
      spyOn(childProcess, 'spawn'),
      spyOn(childProcess, 'spawnSync'),
      spyOn(childProcess, 'exec'),
      spyOn(childProcess, 'execSync'),
      spyOn(childProcess, 'execFile'),
      spyOn(childProcess, 'execFileSync'),
      spyOn(globalThis, 'fetch'),
      spyOn(Bun, 'spawn'),
      spyOn(Bun, 'spawnSync'),
      spyOn(fs, 'writeFileSync'),
      spyOn(fs, 'appendFileSync'),
      spyOn(fs, 'mkdirSync'),
      spyOn(fs, 'rmSync'),
      spyOn(fs, 'unlinkSync'),
      spyOn(fs, 'renameSync'),
    ]
    try {
      const load = loadOne(env, source('wiki', [root]))
      expect(load.records).toHaveLength(1)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
