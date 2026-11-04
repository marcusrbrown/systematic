import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type CorpusDocument,
  type DocumentKind,
  discoverSourceFiles,
  isDocumentKind,
  KIND_TABLE,
  loadCorpus,
  loadSourceFiles,
  lookupSearchRoot,
  MAX_DEPTH,
  MAX_DISCOVERED_FILES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  newEntryBudget,
  parseCorpusDocument,
  parseMarkdownFrontmatter,
  rejectedProjectRoot,
  resolveSearchRoot,
} from '../../src/lib/search-corpus.js'
import { compileExcludePatterns } from '../../src/lib/search-exclude.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'
import { watchInspections } from '../helpers/watch-inspections.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const FIXTURES = path.join(ROOT_DIR, 'tests/fixtures/search-corpus')
const LIFECYCLE_ROOT = path.join(FIXTURES, 'lifecycle')
const HOSTILE_ROOT = path.join(FIXTURES, 'hostile')
const PAST_WORK_ROOT = path.join(FIXTURES, 'past-work')
const LIFECYCLE_DIR = 'docs/solutions/lifecycle'

const temp = createTempDirTracker()
afterEach(() => temp.cleanup())

function makeTemp(): string {
  const dir = temp.track(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-corpus-'))),
  )
  return dir
}

function writeFile(root: string, relative: string, content: string): void {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function doc(title: string, extra = ''): string {
  return `---\ntitle: ${title}\n${extra}---\n\nBody of ${title}.\n`
}

function hasControlCharacter(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
}

function byPath(
  documents: readonly CorpusDocument[],
  relative: string,
): CorpusDocument {
  const found = documents.find((candidate) => candidate.path === relative)
  if (found === undefined) throw new Error(`no document ${relative}`)
  return found
}

describe('resolveSearchRoot', () => {
  it('resolves to the ancestor holding a .git directory', () => {
    const root = makeTemp()
    fs.mkdirSync(path.join(root, '.git'))
    const start = path.join(root, 'packages', 'app')
    fs.mkdirSync(start, { recursive: true })
    expect(resolveSearchRoot(start)).toBe(root)
  })

  it('resolves to the ancestor holding a .git file (worktree)', () => {
    const root = makeTemp()
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n')
    const start = path.join(root, 'a', 'b')
    fs.mkdirSync(start, { recursive: true })
    expect(resolveSearchRoot(start)).toBe(root)
  })

  it('resolves to the start directory when no ancestor holds .git', () => {
    const start = makeTemp()
    expect(resolveSearchRoot(start)).toBe(start)
  })

  it('picks the nearest .git when several ancestors have one', () => {
    const outer = makeTemp()
    fs.mkdirSync(path.join(outer, '.git'))
    const inner = path.join(outer, 'nested')
    fs.mkdirSync(path.join(inner, '.git'), { recursive: true })
    expect(resolveSearchRoot(path.join(inner, 'src'))).toBe(inner)
    expect(resolveSearchRoot(inner)).toBe(inner)
  })

  it('resolves a symlinked start directory through realpath', () => {
    const root = makeTemp()
    fs.mkdirSync(path.join(root, '.git'))
    fs.mkdirSync(path.join(root, 'real'))
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'))
    expect(resolveSearchRoot(path.join(root, 'link'))).toBe(root)
  })

  it('returns a realpath even when the start directory does not exist', () => {
    const base = makeTemp()
    const missing = path.join(base, 'missing')
    expect(resolveSearchRoot(missing)).toBe(missing)
  })

  it('resolves the macOS-style temp symlink to its real path', () => {
    const start = makeTemp()
    // os.tmpdir() may be a symlink (macOS /var to /private/var); the result is the real path.
    const viaTmp = path.join(os.tmpdir(), path.basename(start))
    expect(resolveSearchRoot(viaTmp)).toBe(fs.realpathSync(viaTmp))
  })
})

describe('lookupSearchRoot', () => {
  it('finds the ancestor holding a .git directory from a subpackage', () => {
    const root = makeTemp()
    fs.mkdirSync(path.join(root, '.git'))
    const start = path.join(root, 'packages', 'app')
    fs.mkdirSync(start, { recursive: true })
    expect(lookupSearchRoot(start)).toEqual({ root, foundGit: true })
  })

  it('counts a .git file as a repository marker', () => {
    const root = makeTemp()
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n')
    const start = path.join(root, 'a', 'b')
    fs.mkdirSync(start, { recursive: true })
    expect(lookupSearchRoot(start)).toEqual({ root, foundGit: true })
  })

  it('returns each nested repository its own root', () => {
    const outer = makeTemp()
    fs.mkdirSync(path.join(outer, '.git'))
    const inner = path.join(outer, 'vendor', 'lib')
    fs.mkdirSync(path.join(inner, '.git'), { recursive: true })
    fs.mkdirSync(path.join(inner, 'src'))
    fs.mkdirSync(path.join(outer, 'docs'))
    expect(lookupSearchRoot(path.join(inner, 'src')).root).toBe(inner)
    expect(lookupSearchRoot(path.join(outer, 'docs')).root).toBe(outer)
  })

  it('reports not found and hands back the start directory string untouched', () => {
    const start = makeTemp()
    // The same directory reached through a trailing slash: the string must not be normalized.
    const withSlash = `${start}${path.sep}`
    expect(lookupSearchRoot(withSlash)).toEqual({
      root: withSlash,
      foundGit: false,
    })
  })

  it('does not realpath the start directory when no repository is found', () => {
    const base = makeTemp()
    const real = path.join(base, 'real')
    fs.mkdirSync(real)
    const link = path.join(base, 'link')
    fs.symlinkSync(real, link)
    expect(lookupSearchRoot(link)).toEqual({ root: link, foundGit: false })
  })

  it('returns the repository root realpath from a symlinked start directory', () => {
    const base = makeTemp()
    const repo = path.join(base, 'repo')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true })
    const link = path.join(base, 'link')
    fs.symlinkSync(path.join(repo, 'packages', 'app'), link)
    expect(lookupSearchRoot(link)).toEqual({ root: repo, foundGit: true })
  })

  it('stops at an unreadable ancestor as not found, without throwing', () => {
    if (process.getuid?.() === 0) return // root ignores directory permissions
    const base = makeTemp()
    const locked = path.join(base, 'locked')
    const start = path.join(locked, 'inner')
    fs.mkdirSync(start, { recursive: true })
    fs.mkdirSync(path.join(base, '.git'))
    fs.chmodSync(locked, 0o000)
    try {
      expect(lookupSearchRoot(start)).toEqual({ root: start, foundGit: false })
    } finally {
      fs.chmodSync(locked, 0o755)
    }
  })
})

describe('KIND_TABLE', () => {
  it('has the four kinds, with the solution corpus exclusions and lifecycle on', () => {
    expect(Object.keys(KIND_TABLE)).toEqual([
      'solution',
      'plan',
      'brainstorm',
      'ideation',
    ])
    expect(KIND_TABLE.solution.dir).toBe('docs/solutions')
    expect(KIND_TABLE.solution.excludedFiles).toEqual([
      'readme.md',
      'critical-patterns.md',
    ])
    expect(KIND_TABLE.solution.excludedDirs).toEqual(['_archived'])
    expect(KIND_TABLE.solution.lifecycle).toBe(true)
  })

  it('points each new kind at its docs directory, excluding README and _archived', () => {
    expect(KIND_TABLE.plan.dir).toBe('docs/plans')
    expect(KIND_TABLE.brainstorm.dir).toBe('docs/brainstorms')
    expect(KIND_TABLE.ideation.dir).toBe('docs/ideation')
    for (const kind of ['plan', 'brainstorm', 'ideation'] as const) {
      expect(KIND_TABLE[kind].excludedFiles).toEqual(['readme.md'])
      expect(KIND_TABLE[kind].excludedDirs).toEqual(['_archived'])
      expect(KIND_TABLE[kind].lifecycle).toBe(true)
    }
  })

  it('recognises only table keys as kinds', () => {
    for (const kind of ['solution', 'plan', 'brainstorm', 'ideation']) {
      expect(isDocumentKind(kind)).toBe(true)
    }
    expect(isDocumentKind('all')).toBe(false)
    expect(isDocumentKind('bogus')).toBe(false)
    expect(isDocumentKind('toString')).toBe(false)
    expect(isDocumentKind(undefined)).toBe(false)
  })
})

describe('loadCorpus: layout and exclusions', () => {
  it('reports state none when docs/solutions does not exist', () => {
    const root = makeTemp()
    const result = loadCorpus(root)
    expect(result.state).toBe('none')
    expect(result.documents).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('reports state none when docs/solutions is a plain file', () => {
    const root = makeTemp()
    writeFile(root, 'docs/solutions', 'not a directory')
    expect(loadCorpus(root).state).toBe('none')
  })

  it('reports an empty loaded corpus for an empty directory', () => {
    const root = makeTemp()
    fs.mkdirSync(path.join(root, 'docs/solutions'), { recursive: true })
    const result = loadCorpus(root)
    expect(result.state).toBe('loaded')
    expect(result.documents).toEqual([])
  })

  it('returns docs sorted by code-unit path with root-relative / paths', () => {
    const root = makeTemp()
    writeFile(root, 'docs/solutions/b/z.md', doc('Z'))
    writeFile(root, 'docs/solutions/a-b.md', doc('A dash B'))
    writeFile(root, 'docs/solutions/a/x.md', doc('A slash X'))
    writeFile(root, 'docs/solutions/Z.md', doc('Capital Z'))
    writeFile(root, 'docs/solutions/a.md', doc('A'))
    const paths = loadCorpus(root).documents.map((d) => d.path)
    // "-" (45) sorts before "/" (47) and "." (46); capitals sort before lowercase.
    expect(paths).toEqual([
      'docs/solutions/Z.md',
      'docs/solutions/a-b.md',
      'docs/solutions/a.md',
      'docs/solutions/a/x.md',
      'docs/solutions/b/z.md',
    ])
    for (const p of paths) expect(p).not.toContain('\\')
  })

  it('excludes README, critical-patterns.md and _archived/, and non-markdown files', () => {
    const root = makeTemp()
    writeFile(root, 'docs/solutions/keep.md', doc('Keep'))
    writeFile(root, 'docs/solutions/README.md', doc('Readme'))
    writeFile(root, 'docs/solutions/sub/readme.md', doc('Nested readme'))
    writeFile(root, 'docs/solutions/critical-patterns.md', doc('Critical'))
    writeFile(root, 'docs/solutions/_archived/old.md', doc('Old'))
    writeFile(root, 'docs/solutions/sub/_archived/deep/old.md', doc('Deep old'))
    writeFile(root, 'docs/solutions/notes.txt', 'plain text')
    const result = loadCorpus(root)
    expect(result.documents.map((d) => d.path)).toEqual([
      'docs/solutions/keep.md',
    ])
    expect(result.warnings).toEqual([])
  })

  it('walks to maxDepth 6 and ignores files deeper than that', () => {
    const root = makeTemp()
    const levels = (n: number) =>
      Array.from({ length: n }, (_, i) => `d${i + 1}`).join('/')
    writeFile(root, 'docs/solutions/depth0.md', doc('Depth 0'))
    writeFile(
      root,
      `docs/solutions/${levels(MAX_DEPTH)}/depth6.md`,
      doc('Depth 6'),
    )
    writeFile(
      root,
      `docs/solutions/${levels(MAX_DEPTH + 1)}/depth7.md`,
      doc('Depth 7'),
    )
    const result = loadCorpus(root)
    // Sorted by path, so the nested file ("d1/...") precedes "depth0.md".
    expect(result.documents.map((d) => d.title)).toEqual(['Depth 6', 'Depth 0'])
    expect(result.warnings).toEqual([])
  })

  it('reads from disk on every call, so a doc written between calls appears', () => {
    const root = makeTemp()
    writeFile(root, 'docs/solutions/first.md', doc('First'))
    expect(loadCorpus(root).documents).toHaveLength(1)
    writeFile(root, 'docs/solutions/second.md', doc('Second'))
    expect(loadCorpus(root).documents.map((d) => d.title)).toEqual([
      'First',
      'Second',
    ])
  })

  it('does not write into the project while loading', () => {
    const root = makeTemp()
    writeFile(root, 'docs/solutions/a.md', doc('A'))
    const before = fs.readdirSync(root, { recursive: true }).sort()
    loadCorpus(root)
    expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(before)
  })
})

describe('loadCorpus: symlinks and containment', () => {
  it('loads nothing, with one warning, when docs/solutions links outside the root', () => {
    const outside = makeTemp()
    writeFile(
      outside,
      'secret.md',
      doc('Outside secret', 'tags:\n  - exfil-marker\n'),
    )
    const root = makeTemp()
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
    fs.symlinkSync(outside, path.join(root, 'docs/solutions'))

    const result = loadCorpus(root)
    expect(result.state).toBe('none')
    expect(result.documents).toEqual([])
    expect(result.warnings).toHaveLength(1)
    const everything = JSON.stringify(result)
    expect(everything).not.toContain('Outside secret')
    expect(everything).not.toContain('exfil-marker')
    expect(everything).not.toContain(outside)
  })

  it('loads a docs/solutions symlink that stays inside the root, under the logical path', () => {
    const root = makeTemp()
    writeFile(root, 'knowledge/entry.md', doc('Entry'))
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
    fs.symlinkSync(
      path.join(root, 'knowledge'),
      path.join(root, 'docs/solutions'),
    )
    const result = loadCorpus(root)
    expect(result.documents.map((d) => d.path)).toEqual([
      'docs/solutions/entry.md',
    ])
    expect(result.warnings).toEqual([])
  })

  it('skips a symlinked file and does not descend a symlinked directory', () => {
    const outside = makeTemp()
    writeFile(outside, 'target.md', doc('Outside file'))
    writeFile(outside, 'dir/inner.md', doc('Outside directory file'))
    const root = makeTemp()
    writeFile(root, 'docs/solutions/real.md', doc('Real'))
    fs.symlinkSync(
      path.join(outside, 'target.md'),
      path.join(root, 'docs/solutions/linked.md'),
    )
    fs.symlinkSync(
      path.join(outside, 'dir'),
      path.join(root, 'docs/solutions/linked-dir'),
    )
    // A symlink to a file inside the corpus is skipped too.
    fs.symlinkSync(
      path.join(root, 'docs/solutions/real.md'),
      path.join(root, 'docs/solutions/alias.md'),
    )
    const result = loadCorpus(root)
    expect(result.documents.map((d) => d.title)).toEqual(['Real'])
    expect(JSON.stringify(result)).not.toContain('Outside')
  })

  it('skips a dangling symlink without a throw', () => {
    const root = makeTemp()
    writeFile(root, 'docs/solutions/real.md', doc('Real'))
    fs.symlinkSync(
      path.join(root, 'missing-target.md'),
      path.join(root, 'docs/solutions/dangling.md'),
    )
    expect(loadCorpus(root).documents.map((d) => d.title)).toEqual(['Real'])
  })

  // Root ignores mode bits, so a root run reports a skip, not a false pass.
  it.skipIf(process.getuid?.() === 0)(
    'warns and does not throw on an unreadable subdirectory',
    () => {
      const root = makeTemp()
      writeFile(root, 'docs/solutions/ok.md', doc('Ok'))
      writeFile(root, 'docs/solutions/locked/inner.md', doc('Inner'))
      const locked = path.join(root, 'docs/solutions/locked')
      fs.chmodSync(locked, 0o000)
      try {
        const result = loadCorpus(root)
        expect(result.documents.map((d) => d.title)).toEqual(['Ok'])
        expect(result.warnings).toEqual([
          'could not read directory docs/solutions/locked',
        ])
      } finally {
        fs.chmodSync(locked, 0o755)
      }
    },
  )
})

describe('loadCorpus: access failures versus absence', () => {
  const lockedModes: Array<{ readonly target: string; readonly mode: number }> =
    []
  // Restore first: the tracker's cleanup cannot remove a directory it cannot read.
  afterEach(() => {
    for (const { target, mode } of lockedModes.splice(0)) {
      fs.chmodSync(target, mode)
    }
  })

  it.skipIf(process.getuid?.() === 0)(
    'keeps state none but warns, without error text, when docs/ cannot be traversed',
    () => {
      const root = makeTemp()
      writeFile(root, 'docs/solutions/ok.md', doc('Ok'))
      const docs = path.join(root, 'docs')
      lockedModes.push({ target: docs, mode: 0o755 })
      fs.chmodSync(docs, 0o000)

      const result = loadCorpus(root)
      expect(result.state).toBe('none')
      expect(result.documents).toEqual([])
      expect(result.warnings).toEqual([
        'could not read docs/solutions; not loaded',
      ])
      expect(JSON.stringify(result)).not.toMatch(/EACCES|permission|errno/i)
    },
  )

  // A locked directory fails `realpath` on macOS but not on Linux; failing the
  // listing directly holds the same result on both.
  it('treats a kind directory that exists but cannot be listed like one that cannot be traversed', () => {
    const root = makeTemp()
    writeFile(root, 'docs/solutions/ok.md', doc('Ok'))
    const target = path.join(fs.realpathSync(root), 'docs/solutions')
    const realReaddir = fs.readdirSync.bind(fs)
    const spy = spyOn(fs, 'readdirSync').mockImplementation(((
      dir: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (String(dir) === target) {
        throw Object.assign(new Error('EACCES: permission denied'), {
          code: 'EACCES',
        })
      }
      return (realReaddir as (...args: unknown[]) => unknown)(dir, ...rest)
    }) as typeof fs.readdirSync)
    let result: ReturnType<typeof loadCorpus>
    try {
      result = loadCorpus(root)
    } finally {
      spy.mockRestore()
    }

    expect(result.state).toBe('none')
    expect(result.documents).toEqual([])
    expect(result.warnings).toEqual([
      'could not read docs/solutions; not loaded',
    ])
  })

  it.skipIf(process.getuid?.() === 0)(
    'reports a locked kind directory the same way whatever the platform does with realpath',
    () => {
      const root = makeTemp()
      writeFile(root, 'docs/solutions/ok.md', doc('Ok'))
      const solutions = path.join(root, 'docs/solutions')
      lockedModes.push({ target: solutions, mode: 0o755 })
      fs.chmodSync(solutions, 0o000)

      const result = loadCorpus(root)
      expect(result.state).toBe('none')
      expect(result.warnings).toEqual([
        'could not read docs/solutions; not loaded',
      ])
    },
  )

  it('gives no warning when docs/solutions does not exist', () => {
    const root = makeTemp()
    expect(loadCorpus(root)).toMatchObject({ state: 'none', warnings: [] })
  })

  it('gives no warning when docs is a plain file', () => {
    const root = makeTemp()
    writeFile(root, 'docs', 'not a directory')
    expect(loadCorpus(root)).toMatchObject({ state: 'none', warnings: [] })
  })
})

describe('loadCorpus: caps', () => {
  it('skips a file of 256 KB + 1 with a warning, and loads one of exactly 256 KB', () => {
    const root = makeTemp()
    const header = '---\ntitle: Sized\n---\n'
    const fill = (total: number) => header + 'x'.repeat(total - header.length)
    writeFile(root, 'docs/solutions/a-exact.md', fill(MAX_FILE_BYTES))
    writeFile(root, 'docs/solutions/b-over.md', fill(MAX_FILE_BYTES + 1))
    const result = loadCorpus(root)
    expect(result.documents.map((d) => d.path)).toEqual([
      'docs/solutions/a-exact.md',
    ])
    expect(result.warnings).toEqual([
      `skipped docs/solutions/b-over.md: larger than ${MAX_FILE_BYTES} bytes`,
    ])
  })

  it('stops at 2,000 files with one warning that counts the rest', () => {
    const root = makeTemp()
    for (let i = 0; i < MAX_FILES + 1; i++) {
      const name = `f${String(i).padStart(5, '0')}.md`
      writeFile(root, `docs/solutions/${name}`, `# ${name}\n`)
    }
    const result = loadCorpus(root)
    expect(result.documents).toHaveLength(MAX_FILES)
    expect(result.documents[MAX_FILES - 1]?.path).toBe(
      'docs/solutions/f01999.md',
    )
    expect(result.warnings).toEqual([
      `docs/solutions: file limit of ${MAX_FILES} reached; skipped 1 files`,
    ])
  })

  it('stops at the 16 MB budget in sorted path order and counts the files skipped', () => {
    const root = makeTemp()
    const size = MAX_FILE_BYTES
    const total = 70
    const header = '---\ntitle: Big\n---\n'
    const body = header + 'x'.repeat(size - header.length)
    for (let i = 0; i < total; i++) {
      writeFile(
        root,
        `docs/solutions/big-${String(i).padStart(3, '0')}.md`,
        body,
      )
    }
    const fits = Math.floor(MAX_TOTAL_BYTES / size)
    const result = loadCorpus(root)
    expect(result.documents).toHaveLength(fits)
    // The first files in sorted order are the ones kept.
    expect(result.documents.at(-1)?.path).toBe(
      `docs/solutions/big-${String(fits - 1).padStart(3, '0')}.md`,
    )
    expect(result.warnings).toEqual([
      `docs/solutions: text budget of ${MAX_TOTAL_BYTES} bytes reached; skipped ${total - fits} files`,
    ])
  })
})

describe('loadCorpus: parsing', () => {
  it('indexes a doc with no frontmatter as body-only with no warning', () => {
    const result = loadCorpus(HOSTILE_ROOT)
    const plain = byPath(result.documents, 'docs/solutions/no-frontmatter.md')
    expect(plain.title).toBe('no-frontmatter')
    expect(plain.body).toContain('Body-only document.')
    expect(plain.tags).toEqual([])
    expect(plain.status).toBeUndefined()
    expect(plain.supersededBy).toEqual({ state: 'none' })
    expect(result.warnings.join('\n')).not.toContain('no-frontmatter')
  })

  it('parses a leading BOM', () => {
    const root = makeTemp()
    writeFile(root, 'docs/solutions/bom.md', `\uFEFF${doc('With BOM')}`)
    const [parsed] = loadCorpus(root).documents
    expect(parsed?.title).toBe('With BOM')
    expect(parsed?.body).toContain('Body of With BOM.')
  })

  it('parses a closing --- at end of file with no trailing newline', () => {
    const root = makeTemp()
    writeFile(
      root,
      'docs/solutions/eof.md',
      '---\ntitle: Ends at the fence\ntags:\n  - eof\n---',
    )
    const result = loadCorpus(root)
    expect(result.warnings).toEqual([])
    const [parsed] = result.documents
    expect(parsed?.title).toBe('Ends at the fence')
    expect(parsed?.tags).toEqual(['eof'])
    expect(parsed?.body).toBe('')
  })

  it('parses CRLF line endings', () => {
    const root = makeTemp()
    writeFile(
      root,
      'docs/solutions/crlf.md',
      '---\r\ntitle: Windows\r\ntags:\r\n  - crlf\r\n---\r\n\r\nBody.\r\n',
    )
    const [parsed] = loadCorpus(root).documents
    expect(parsed?.title).toBe('Windows')
    expect(parsed?.tags).toEqual(['crlf'])
  })

  it('narrows every known field from a full solution frontmatter block', () => {
    const parsed = parseCorpusDocument(
      'solution',
      'docs/solutions/x/full.md',
      [
        '---',
        'title:  Full doc ',
        'module: build',
        'component: bundler',
        'problem_type: build_error',
        'tags:',
        '  - esm',
        '  - 404',
        'symptoms:',
        '  - "Cannot find module"',
        'applies_when: "A single string"',
        'status: stale',
        'stale_reason: Retired in favour of x',
        'superseded_by: docs/solutions/y.md',
        '---',
        '',
        'Body.',
      ].join('\n'),
    )
    expect(parsed).toEqual({
      ok: true,
      document: {
        path: 'docs/solutions/x/full.md',
        kind: 'solution',
        title: 'Full doc',
        tags: ['esm', '404'],
        module: 'build',
        component: 'bundler',
        problemType: 'build_error',
        symptoms: ['Cannot find module'],
        appliesWhen: ['A single string'],
        status: 'stale',
        supersededBy: { state: 'value', value: 'docs/solutions/y.md' },
        staleReason: 'Retired in favour of x',
        body: '\nBody.\n',
      },
    })
  })

  it('skips invalid YAML with a warning naming the path', () => {
    const result = loadCorpus(HOSTILE_ROOT)
    expect(
      result.documents.some((d) => d.path.endsWith('invalid-yaml.md')),
    ).toBe(false)
    expect(result.warnings).toContain(
      'skipped docs/solutions/invalid-yaml.md: invalid frontmatter',
    )
  })

  it('skips a frontmatter block that is not a mapping, with a warning', () => {
    const result = loadCorpus(HOSTILE_ROOT)
    expect(
      result.documents.some((d) => d.path.endsWith('non-mapping.md')),
    ).toBe(false)
    expect(result.warnings).toContain(
      'skipped docs/solutions/non-mapping.md: frontmatter is not a mapping',
    )
  })

  it('survives a cyclic alias without stringifying it', () => {
    const result = loadCorpus(HOSTILE_ROOT)
    const cyclic = byPath(result.documents, 'docs/solutions/cyclic-alias.md')
    expect(cyclic.title).toBe('Cyclic alias')
    expect(cyclic.tags).toEqual([])
    expect(cyclic.symptoms).toEqual([])
    expect(cyclic.body).toContain('Body survives a cyclic alias.')
    // The whole load result must serialise: a stray cyclic reference would throw.
    expect(() => JSON.stringify(result)).not.toThrow()
  })

  it('drops non-string entries and mis-typed fields, keeping what narrows', () => {
    const result = loadCorpus(HOSTILE_ROOT)
    const nested = byPath(result.documents, 'docs/solutions/nested-objects.md')
    expect(nested.title).toBe('nested-objects')
    expect(nested.tags).toEqual(['good', '404'])
    expect(nested.module).toBeUndefined()
    expect(nested.status).toBeUndefined()
    expect(nested.supersededBy).toEqual({ state: 'invalid' })
    expect(JSON.stringify(nested)).not.toContain('[object')
  })

  it('does not accept non-finite numbers or booleans as tags', () => {
    const parsed = parseCorpusDocument(
      'solution',
      'docs/solutions/n.md',
      '---\ntags:\n  - true\n  - 1.5\n  - -.inf\n  - ok\n---\n',
    )
    expect(parsed.ok && parsed.document.tags).toEqual(['1.5', 'ok'])
  })

  it('strips control characters and escapes from warnings', () => {
    const root = makeTemp()
    writeFile(
      root,
      'docs/solutions/bad\u001b[31m-name\u0007.md',
      '---\ntitle: [unterminated\ntags: {\n---\n',
    )
    const { warnings } = loadCorpus(root)
    expect(warnings).toEqual([
      'skipped docs/solutions/bad-name.md: invalid frontmatter',
    ])
    for (const warning of warnings) {
      expect(hasControlCharacter(warning)).toBe(false)
    }
  })

  it('caps the length of a warning', () => {
    const root = makeTemp()
    const longName = `${'n'.repeat(120)}.md`
    writeFile(
      root,
      `docs/solutions/${longName}`,
      '---\ntitle: [unterminated\n---\n',
    )
    const [warning] = loadCorpus(root).warnings
    expect(warning?.length).toBeLessThan(300)
  })
})

describe('loadCorpus: lifecycle fixture corpus', () => {
  const result = loadCorpus(LIFECYCLE_ROOT)
  const at = (name: string) =>
    byPath(result.documents, `${LIFECYCLE_DIR}/${name}.md`)
  const link = (name: string) => ({
    state: 'value' as const,
    value: `${LIFECYCLE_DIR}/${name}.md`,
  })

  it('loads every fixture except the excluded files and the invalid one', () => {
    expect(result.state).toBe('loaded')
    expect(result.documents.map((d) => d.path)).toEqual(
      [...result.documents.map((d) => d.path)].sort(),
    )
    const paths = new Set(result.documents.map((d) => d.path))
    expect(paths.has('docs/solutions/README.md')).toBe(false)
    expect(paths.has('docs/solutions/critical-patterns.md')).toBe(false)
    expect(paths.has('docs/solutions/_archived/retired.md')).toBe(false)
    expect(paths.has(`${LIFECYCLE_DIR}/broken-target.md`)).toBe(false)
    expect(result.warnings).toEqual([
      `skipped ${LIFECYCLE_DIR}/broken-target.md: invalid frontmatter`,
    ])
  })

  it('keeps chain, hop-cap, cycle and dangling links intact', () => {
    expect(at('chain-a')).toMatchObject({
      status: 'superseded',
      supersededBy: link('chain-b'),
    })
    expect(at('chain-b')).toMatchObject({
      status: 'active',
      supersededBy: { state: 'none' },
    })
    for (let i = 0; i < 5; i++) {
      expect(at(`five-${i}`)).toMatchObject({
        status: 'superseded',
        supersededBy: link(`five-${i + 1}`),
      })
    }
    expect(at('five-5').status).toBeUndefined()
    for (let i = 0; i < 6; i++) {
      expect(at(`six-${i}`).supersededBy).toEqual(link(`six-${i + 1}`))
    }
    expect(at('six-6').supersededBy).toEqual({ state: 'none' })
    expect(at('cycle-a').supersededBy).toEqual(link('cycle-b'))
    expect(at('cycle-b').supersededBy).toEqual(link('cycle-a'))
    expect(at('self-link').supersededBy).toEqual(link('self-link'))
    expect(at('dangling').supersededBy).toEqual(link('does-not-exist'))
  })

  it('keeps every malformed successor shape for the resolver to judge', () => {
    expect(at('bad-parent-dir').supersededBy).toEqual({
      state: 'value',
      value: 'docs/solutions/../lifecycle/chain-b.md',
    })
    expect(at('bad-absolute').supersededBy).toEqual({
      state: 'value',
      value: '/etc/chain-b.md',
    })
    expect(at('bad-readme').supersededBy).toEqual({
      state: 'value',
      value: 'docs/solutions/README.md',
    })
    expect(at('bad-archived').supersededBy).toEqual({
      state: 'value',
      value: 'docs/solutions/_archived/retired.md',
    })
    expect(at('bad-critical').supersededBy).toEqual({
      state: 'value',
      value: 'docs/solutions/critical-patterns.md',
    })
    expect(at('bad-bare').supersededBy).toEqual({
      state: 'value',
      value: 'chain-b.md',
    })
    expect(at('bad-list').supersededBy).toEqual({ state: 'invalid' })
    expect(at('bad-empty').supersededBy).toEqual({ state: 'value', value: '' })
    expect(at('bad-null').supersededBy).toEqual({ state: 'none' })
    expect(at('bad-number').supersededBy).toEqual({ state: 'invalid' })
    for (const name of [
      'bad-parent-dir',
      'bad-absolute',
      'bad-readme',
      'bad-archived',
      'bad-critical',
      'bad-bare',
      'bad-list',
      'bad-empty',
      'bad-null',
      'bad-number',
    ]) {
      expect(at(name).status).toBe('superseded')
    }
  })

  it('keeps merge, shared-successor, stale and status cases intact', () => {
    expect(at('merge-a').supersededBy).toEqual(link('merge-successor'))
    expect(at('merge-b').supersededBy).toEqual(link('merge-successor'))
    expect(at('merge-successor').status).toBe('active')
    expect(at('skipped-target').supersededBy).toEqual(link('broken-target'))
    expect(at('dual-unresolved').supersededBy).toEqual(link('does-not-exist'))
    expect(at('into-dual').supersededBy).toEqual(link('dual-unresolved'))
    expect(at('stale-doc')).toMatchObject({
      status: 'stale',
      staleReason: 'The retry budget was removed in 2026-09.',
    })
    expect(at('unknown-status').status).toBe('draft')
    expect(at('no-status')).toMatchObject({
      status: undefined,
      supersededBy: { state: 'none' },
      staleReason: undefined,
    })
  })

  it('reads a trailing YAML comment as part of neither status nor successor', () => {
    expect(at('comment-a')).toMatchObject({
      status: 'superseded',
      supersededBy: link('chain-b'),
    })
  })
})

const NEW_KINDS: Array<{ kind: DocumentKind; dir: string }> = [
  { kind: 'plan', dir: 'docs/plans' },
  { kind: 'brainstorm', dir: 'docs/brainstorms' },
  { kind: 'ideation', dir: 'docs/ideation' },
]

describe('loadCorpus: plans, brainstorms and ideation', () => {
  it('loads three plans, one with an older filename style, and no excluded file', () => {
    const result = loadCorpus(PAST_WORK_ROOT, 'plan')
    expect(result.state).toBe('loaded')
    expect(result.warnings).toEqual([])
    expect(result.documents.map((d) => d.path)).toEqual([
      'docs/plans/2026-03-04-feat-old-style-plan.md',
      'docs/plans/2026-10-01-001-feat-alpha-plan.md',
      'docs/plans/2026-10-02-002-fix-beta-plan.md',
    ])
    for (const document of result.documents) expect(document.kind).toBe('plan')
  })

  it.each(NEW_KINDS)(
    'excludes README.md and _archived/ for $kind',
    ({ kind, dir }) => {
      const paths = loadCorpus(PAST_WORK_ROOT, kind).documents.map(
        (d) => d.path,
      )
      expect(paths.length).toBeGreaterThan(0)
      expect(paths).not.toContain(`${dir}/README.md`)
      expect(paths).not.toContain(`${dir}/_archived/old.md`)
      for (const documentPath of paths) {
        expect(documentPath.startsWith(`${dir}/`)).toBe(true)
      }
    },
  )

  it('loads brainstorms and ideation documents under their own kinds', () => {
    expect(
      loadCorpus(PAST_WORK_ROOT, 'brainstorm').documents.map((d) => d.path),
    ).toEqual([
      'docs/brainstorms/2026-10-01-topic-only-requirements.md',
      'docs/brainstorms/2026-10-02-both-requirements.md',
      'docs/brainstorms/2026-10-03-neither-requirements.md',
    ])
    expect(
      loadCorpus(PAST_WORK_ROOT, 'ideation').documents.map((d) => d.path),
    ).toEqual(['docs/ideation/2026-10-01-open-ideation.md'])
  })

  it('does not load a new kind through the default solution kind', () => {
    // The fixture holds no docs/solutions, so the default kind finds nothing.
    expect(loadCorpus(PAST_WORK_ROOT)).toMatchObject({
      state: 'none',
      documents: [],
    })
  })

  it('uses the topic as the title when there is no title', () => {
    const { documents } = loadCorpus(PAST_WORK_ROOT, 'brainstorm')
    expect(
      byPath(
        documents,
        'docs/brainstorms/2026-10-01-topic-only-requirements.md',
      ).title,
    ).toBe('foo')
  })

  it('prefers the title over the topic', () => {
    const { documents } = loadCorpus(PAST_WORK_ROOT, 'brainstorm')
    expect(
      byPath(documents, 'docs/brainstorms/2026-10-02-both-requirements.md')
        .title,
    ).toBe('A')
  })

  it('falls back to the file name without .md when there is neither', () => {
    const { documents } = loadCorpus(PAST_WORK_ROOT, 'brainstorm')
    expect(
      byPath(documents, 'docs/brainstorms/2026-10-03-neither-requirements.md')
        .title,
    ).toBe('2026-10-03-neither-requirements')
  })

  it('uses the quoted plan title as written', () => {
    const { documents } = loadCorpus(PAST_WORK_ROOT, 'plan')
    expect(
      byPath(documents, 'docs/plans/2026-10-01-001-feat-alpha-plan.md').title,
    ).toBe('feat: Alpha rollout')
  })

  it('keeps the solution-only fields empty for the new kinds', () => {
    const { documents } = loadCorpus(PAST_WORK_ROOT, 'plan')
    for (const document of documents) {
      expect(document).toMatchObject({
        tags: [],
        module: undefined,
        component: undefined,
        problemType: undefined,
        symptoms: [],
        appliesWhen: [],
      })
    }
  })

  it('reads the status of a new kind as written', () => {
    const { documents } = loadCorpus(PAST_WORK_ROOT, 'brainstorm')
    expect(
      byPath(documents, 'docs/brainstorms/2026-10-02-both-requirements.md')
        .status,
    ).toBe('abandoned')
  })

  describe.each([
    ['an empty title', "title: ''"],
    ['a blank title', "title: '   '"],
    ['a list title', 'title: [Plan Title]'],
    ['a numeric title', 'title: 42'],
  ])('title chain with %s', (_label, titleLine) => {
    const parse = (extra: string) =>
      parseCorpusDocument(
        'plan',
        'docs/plans/2026-10-04-x-plan.md',
        `---\n${titleLine}\n${extra}---\n\nBody.\n`,
      )

    it('falls through to the topic', () => {
      const parsed = parse('topic:  Real topic \n')
      expect(parsed.ok && parsed.document.title).toBe('Real topic')
    })

    it('falls through to the file name when the topic is absent', () => {
      const parsed = parse('')
      expect(parsed.ok && parsed.document.title).toBe('2026-10-04-x-plan')
    })

    it('falls through to the file name when the topic is not a usable string', () => {
      for (const topic of ['topic: 7', 'topic: [a, b]', "topic: ''"]) {
        const parsed = parse(`${topic}\n`)
        expect(parsed.ok && parsed.document.title).toBe('2026-10-04-x-plan')
      }
    })
  })

  it.each(NEW_KINDS)(
    'loads a $kind file with no frontmatter as body-only, with no warning',
    ({ kind, dir }) => {
      const root = makeTemp()
      writeFile(root, `${dir}/2026-01-01-bare.md`, 'Just prose about zebras.\n')
      const result = loadCorpus(root, kind)
      expect(result.warnings).toEqual([])
      expect(result.documents).toHaveLength(1)
      expect(result.documents[0]).toMatchObject({
        title: '2026-01-01-bare',
        status: undefined,
        supersededBy: { state: 'none' },
      })
      expect(result.documents[0]?.body).toContain('zebras')
    },
  )

  it.each(NEW_KINDS)(
    'skips invalid YAML and a non-mapping block for $kind with the fixed reasons',
    ({ kind, dir }) => {
      const root = makeTemp()
      writeFile(root, `${dir}/ok.md`, doc('Ok'))
      writeFile(root, `${dir}/bad.md`, '---\ntitle: feat: broken\n---\n')
      writeFile(root, `${dir}/list.md`, '---\n- a\n- b\n---\n')
      const result = loadCorpus(root, kind)
      expect(result.documents.map((d) => d.path)).toEqual([`${dir}/ok.md`])
      expect(result.warnings).toEqual([
        `skipped ${dir}/bad.md: invalid frontmatter`,
        `skipped ${dir}/list.md: frontmatter is not a mapping`,
      ])
    },
  )

  it.each(NEW_KINDS)(
    'reports none, with no warning, when the $kind directory is missing',
    ({ kind }) => {
      const root = makeTemp()
      writeFile(root, 'docs/solutions/other.md', doc('Other'))
      expect(loadCorpus(root, kind)).toEqual({
        state: 'none',
        documents: [],
        warnings: [],
      })
    },
  )

  it.each(NEW_KINDS)(
    'loads zero documents from a $kind directory with no indexable file',
    ({ kind, dir }) => {
      const root = makeTemp()
      writeFile(root, `${dir}/README.md`, doc('Index'))
      writeFile(root, `${dir}/_archived/old.md`, doc('Old'))
      writeFile(root, `${dir}/notes.txt`, 'plain text')
      expect(loadCorpus(root, kind)).toEqual({
        state: 'loaded',
        documents: [],
        warnings: [],
      })
    },
  )

  it('does not load docs/plans when it links outside the root, and the warning names it', () => {
    const outside = makeTemp()
    writeFile(outside, 'secret.md', doc('Outside secret'))
    const root = makeTemp()
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
    fs.symlinkSync(outside, path.join(root, 'docs/plans'))

    const result = loadCorpus(root, 'plan')
    expect(result.state).toBe('none')
    expect(result.documents).toEqual([])
    expect(result.warnings).toEqual([
      'docs/plans resolves outside the project root; not loaded',
    ])
    expect(JSON.stringify(result)).not.toContain('Outside secret')
  })

  it('names the kind directory in a skip warning for a new kind', () => {
    const root = makeTemp()
    writeFile(root, 'docs/brainstorms/big.md', 'x'.repeat(MAX_FILE_BYTES + 1))
    expect(loadCorpus(root, 'brainstorm').warnings).toEqual([
      `skipped docs/brainstorms/big.md: larger than ${MAX_FILE_BYTES} bytes`,
    ])
  })

  it('loads a gitignored kind directory, because the loader never consults git', () => {
    const root = makeTemp()
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n')
    fs.writeFileSync(path.join(root, '.gitignore'), 'docs/brainstorms/\n')
    writeFile(root, 'docs/brainstorms/ignored-requirements.md', doc('Ignored'))
    const result = loadCorpus(resolveSearchRoot(root), 'brainstorm')
    expect(result.state).toBe('loaded')
    expect(result.documents.map((d) => d.title)).toEqual(['Ignored'])
  })
})

describe('loadCorpus: this repository', () => {
  it('loads every real plan with no warnings and a non-empty title', () => {
    const result = loadCorpus(ROOT_DIR, 'plan')
    expect(result.warnings).toEqual([])
    expect(result.state).toBe('loaded')
    expect(result.documents.length).toBeGreaterThan(100)
    for (const document of result.documents) {
      expect(document.title.length).toBeGreaterThan(0)
    }
  })

  it('loads the real docs/solutions/ with no warnings', () => {
    const result = loadCorpus(ROOT_DIR)
    expect(result.warnings).toEqual([])
    expect(result.state).toBe('loaded')
    expect(result.documents.length).toBeGreaterThan(100)
    for (const document of result.documents) {
      expect(document.title.length).toBeGreaterThan(0)
    }
  })
})

describe('loadSourceFiles', () => {
  const MARKDOWN_WALK = { excludedFiles: [], excludedDirs: [] }
  const readText = (displayPath: string, content: string) => ({
    ok: true as const,
    value: `${displayPath}=${content.trim()}`,
  })

  it('walks the extensions it is given, not only .md', () => {
    const root = makeTemp()
    writeFile(root, 'a.txt', 'one')
    writeFile(root, 'b.md', 'two')
    writeFile(root, 'sub/c.TXT', 'three')

    const loaded = loadSourceFiles(
      {
        directory: root,
        walk: { ...MARKDOWN_WALK, extensions: ['.txt'] },
        label: 'src',
      },
      {
        displayPrefix: 'src',
        label: 'src',
        maxFileBytes: 1000,
        parse: readText,
      },
    )

    expect(loaded.state).toBe('loaded')
    if (loaded.state !== 'loaded') return
    expect(loaded.items).toEqual(['src/a.txt=one', 'src/sub/c.TXT=three'])
  })

  it('uses the per-file cap, the display prefix and the label it is given in warnings', () => {
    const root = makeTemp()
    writeFile(root, 'small.md', 'ok')
    writeFile(root, 'big.md', 'x'.repeat(50))

    const loaded = loadSourceFiles(
      { directory: root, walk: MARKDOWN_WALK, label: 'wiki' },
      {
        displayPrefix: 'wiki',
        label: 'wiki',
        maxFileBytes: 10,
        parse: readText,
      },
    )

    if (loaded.state !== 'loaded') throw new Error('not loaded')
    expect(loaded.items).toEqual(['wiki/small.md=ok'])
    expect(loaded.warnings).toEqual([
      'skipped wiki/big.md: larger than 10 bytes',
    ])
    expect(loaded.bytesRead).toBe(2)
  })

  it('contains the directory only when asked: a symlinked root is followed without containment and refused with it', () => {
    const base = makeTemp()
    const checkout = path.join(base, 'repo')
    const outside = path.join(base, 'outside')
    fs.mkdirSync(checkout)
    writeFile(outside, 'a.md', 'text')
    fs.symlinkSync(outside, path.join(checkout, 'link'))
    const read = {
      displayPrefix: 'p',
      label: 'p',
      maxFileBytes: 100,
      parse: readText,
    }

    const free = loadSourceFiles(
      {
        directory: path.join(checkout, 'link'),
        walk: MARKDOWN_WALK,
        label: 'p',
      },
      read,
    )
    const contained = loadSourceFiles(
      {
        directory: path.join(checkout, 'link'),
        containedIn: checkout,
        walk: MARKDOWN_WALK,
        label: 'p',
      },
      read,
    )

    expect(free.state).toBe('loaded')
    expect(contained.state).toBe('outside')
    expect(contained.warnings).toEqual([
      'p resolves outside the project root; not loaded',
    ])
  })

  it('discoverSourceFiles reads no file: it returns sorted candidates with their stat sizes', () => {
    const root = makeTemp()
    writeFile(root, 'b.md', 'bb')
    writeFile(root, 'a.md', 'a')
    const warnings: string[] = []

    const found = discoverSourceFiles(
      { directory: root, walk: MARKDOWN_WALK, label: 'x' },
      warnings,
    )

    if (found.state !== 'found') throw new Error('not found')
    expect(found.candidates.map((c) => [c.relative, c.size])).toEqual([
      ['a.md', 1],
      ['b.md', 2],
    ])
    expect(found.truncated).toBe(false)
  })
})

describe('discoverSourceFiles: excludes', () => {
  const WALK = { excludedFiles: [], excludedDirs: [] }
  const relatives = (found: ReturnType<typeof discoverSourceFiles>) => {
    if (found.state !== 'found') throw new Error('not found')
    return found.candidates.map((candidate) => candidate.relative)
  }

  it('leaves out files and directories the matcher names, at any depth', () => {
    const root = makeTemp()
    writeFile(root, 'keep.md', 'k')
    writeFile(root, 'log.md', 'l')
    writeFile(root, 'sub/log.md', 'l')
    writeFile(root, 'sub/keep.md', 'k')
    writeFile(root, '.stryker-tmp/x.md', 'x')
    writeFile(root, 'deep/.stryker-tmp/y.md', 'y')

    const found = discoverSourceFiles(
      {
        directory: root,
        walk: WALK,
        label: 'x',
        isExcluded: compileExcludePatterns(['log.md', '.stryker-tmp']),
      },
      [],
    )

    expect(relatives(found)).toEqual(['keep.md', 'sub/keep.md'])
  })

  it('matches an anchored pattern against the path below the walked directory', () => {
    const root = makeTemp()
    writeFile(root, 'drafts/a.md', 'a')
    writeFile(root, 'drafts/x/a.md', 'a')
    writeFile(root, 'notes/drafts/a.md', 'a')

    const found = discoverSourceFiles(
      {
        directory: root,
        walk: WALK,
        label: 'x',
        isExcluded: compileExcludePatterns(['drafts/*.md']),
      },
      [],
    )

    expect(relatives(found)).toEqual(['drafts/x/a.md', 'notes/drafts/a.md'])
  })

  it('never inspects an excluded file and never lists or inspects an excluded directory', () => {
    const root = makeTemp()
    writeFile(root, 'keep.md', 'k')
    writeFile(root, 'secret.md', 's')
    writeFile(root, 'vendor/deep/a.md', 'a')
    writeFile(root, 'sub/vendor/b.md', 'b')
    writeFile(root, 'sub/ok.md', 'o')
    const real = fs.realpathSync(root)
    const watch = watchInspections()
    let found: ReturnType<typeof discoverSourceFiles>
    try {
      found = discoverSourceFiles(
        {
          directory: root,
          walk: WALK,
          label: 'x',
          entryBudget: newEntryBudget(100),
          isExcluded: compileExcludePatterns(['secret.md', 'vendor']),
        },
        [],
      )
    } finally {
      watch.stop()
    }

    expect(relatives(found)).toEqual(['keep.md', 'sub/ok.md'])
    const touched = [...watch.statted, ...watch.listed]
    expect(touched.some((target) => target.includes('secret.md'))).toBe(false)
    expect(touched.some((target) => target.includes('vendor'))).toBe(false)
    // The walk still looked at everything else.
    expect(watch.statted).toContain(path.join(real, 'keep.md'))
    expect(watch.listed).toContain(path.join(real, 'sub'))
  })

  it('charges excluded names to the entry budget, so excludes buy no extra listing', () => {
    const root = makeTemp()
    for (let index = 0; index < 20; index++) {
      writeFile(root, `skip${index}.md`, 's')
    }
    writeFile(root, 'keep.md', 'k')
    const budget = newEntryBudget(10)

    discoverSourceFiles(
      {
        directory: root,
        walk: WALK,
        label: 'x',
        entryBudget: budget,
        isExcluded: compileExcludePatterns(['skip*.md']),
      },
      [],
    )

    expect(budget.exhausted).toBe(true)
    expect(budget.remaining).toBe(0)
  })

  it('keeps excluded files out of the discovery ceiling', () => {
    const root = makeTemp()
    for (let index = 0; index < MAX_DISCOVERED_FILES + 5; index++) {
      fs.closeSync(fs.openSync(path.join(root, `skip${index}.md`), 'w'))
    }
    writeFile(root, 'zz-keep.md', 'k')

    const found = discoverSourceFiles(
      {
        directory: root,
        walk: WALK,
        label: 'x',
        isExcluded: compileExcludePatterns(['skip*.md']),
      },
      [],
    )

    expect(relatives(found)).toEqual(['zz-keep.md'])
    if (found.state === 'found') expect(found.truncated).toBe(false)
  })

  it('behaves as before when no matcher is given', () => {
    const root = makeTemp()
    writeFile(root, 'log.md', 'l')
    writeFile(root, 'sub/log.md', 'l')

    const found = discoverSourceFiles(
      { directory: root, walk: WALK, label: 'x' },
      [],
    )

    expect(relatives(found)).toEqual(['log.md', 'sub/log.md'])
  })
})

describe('parseMarkdownFrontmatter', () => {
  it('strips a BOM, accepts a missing trailing newline and returns the body', () => {
    const parsed = parseMarkdownFrontmatter('\uFEFF---\ntitle: T\n---')
    expect(parsed).toEqual({ ok: true, data: { title: 'T' }, body: '' })
  })

  it('returns empty data for a file with no frontmatter', () => {
    expect(parseMarkdownFrontmatter('just text')).toMatchObject({
      ok: true,
      data: {},
      body: 'just text\n',
    })
  })

  it('rejects invalid YAML and a non-mapping block with the corpus reasons', () => {
    expect(parseMarkdownFrontmatter('---\na: [x\n---\n')).toEqual({
      ok: false,
      reason: 'invalid frontmatter',
    })
    expect(parseMarkdownFrontmatter('---\n- a\n---\n')).toEqual({
      ok: false,
      reason: 'frontmatter is not a mapping',
    })
  })
})

describe('rejectedProjectRoot', () => {
  function checkout(): { root: string; outside: string } {
    const base = makeTemp()
    const root = path.join(base, 'repo')
    const outside = path.join(base, 'elsewhere')
    fs.mkdirSync(path.join(root, 'docs/real/sub'), { recursive: true })
    fs.mkdirSync(path.join(outside, 'docs'), { recursive: true })
    return { root, outside }
  }

  it('accepts a plain root, a missing root and a nested root', () => {
    const { root } = checkout()
    expect(rejectedProjectRoot(root, path.join(root, 'docs/real'))).toBe(
      undefined,
    )
    expect(rejectedProjectRoot(root, path.join(root, 'docs/real/sub'))).toBe(
      undefined,
    )
    expect(rejectedProjectRoot(root, path.join(root, 'docs/nope'))).toBe(
      undefined,
    )
  })

  it('names a root that is a symlink and a root below a symlink', () => {
    const { root } = checkout()
    fs.symlinkSync(path.join(root, 'docs/real'), path.join(root, 'docs/linked'))
    expect(rejectedProjectRoot(root, path.join(root, 'docs/linked'))).toBe(
      'root',
    )
    expect(rejectedProjectRoot(root, path.join(root, 'docs/linked/sub'))).toBe(
      'ancestor',
    )
  })

  it('names a root whose real path is not inside the checkout, with or without a link', () => {
    const { root, outside } = checkout()
    expect(rejectedProjectRoot(root, path.join(outside, 'docs'))).toBe(
      'outside',
    )
    fs.symlinkSync(outside, path.join(root, 'via'))
    expect(rejectedProjectRoot(root, path.join(root, 'via'))).toBe('root')
  })

  it('treats the checkout itself as outside: a root must be strictly below it', () => {
    const { root } = checkout()
    expect(rejectedProjectRoot(root, root)).toBe('outside')
  })
})
