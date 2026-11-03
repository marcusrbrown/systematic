import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  loadCorpus,
  MAX_FILE_BYTES,
  MAX_FILES,
} from '../../src/lib/search-corpus.js'
import {
  EXTERNAL_MAX_FILE_BYTES,
  EXTERNAL_TOTAL_BUDGET_BYTES,
  loadExternalSources,
  type SourceLoad,
} from '../../src/lib/search-external.js'
import type { ActiveSource } from '../../src/lib/search-external-sources.js'
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
  return { name, format: 'markdown', roots, origin: 'user', ...overrides }
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

  test('AE10 input: a runbook with an H1 and no frontmatter has a title and no status', () => {
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

  test('R12: the file limit applies to a source, with a named warning', () => {
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
    const original = fs.readFileSync
    const spy = spyOn(fs, 'readFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      reads.push(String(file))
      return (original as (...args: unknown[]) => unknown)(file, ...rest)
    }) as typeof fs.readFileSync)

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
  test('AE5: a symlinked file and a symlinked directory inside a root yield nothing and no warning names the target', () => {
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
