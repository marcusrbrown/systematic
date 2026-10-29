import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type CorpusDocument,
  isDocumentKind,
  KIND_TABLE,
  loadCorpus,
  MAX_DEPTH,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  parseCorpusDocument,
  resolveSearchRoot,
} from '../../src/lib/search-corpus.js'
import { createTempDirTracker } from '../helpers/temp-dirs.js'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const FIXTURES = path.join(ROOT_DIR, 'tests/fixtures/search-corpus')
const LIFECYCLE_ROOT = path.join(FIXTURES, 'lifecycle')
const HOSTILE_ROOT = path.join(FIXTURES, 'hostile')
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

describe('KIND_TABLE', () => {
  it('has one kind, solution, with the corpus exclusions and lifecycle on', () => {
    expect(Object.keys(KIND_TABLE)).toEqual(['solution'])
    expect(KIND_TABLE.solution.dir).toBe('docs/solutions')
    expect(KIND_TABLE.solution.excludedFiles).toEqual([
      'readme.md',
      'critical-patterns.md',
    ])
    expect(KIND_TABLE.solution.excludedDirs).toEqual(['_archived'])
    expect(KIND_TABLE.solution.lifecycle).toBe(true)
  })

  it('recognises only table keys as kinds', () => {
    expect(isDocumentKind('solution')).toBe(true)
    expect(isDocumentKind('plan')).toBe(false)
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

  it('warns and does not throw on an unreadable subdirectory', () => {
    if (process.getuid?.() === 0) return // root ignores mode bits
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
      `file limit of ${MAX_FILES} reached; skipped 1 files`,
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
      `text budget of ${MAX_TOTAL_BYTES} bytes reached; skipped ${total - fits} files`,
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

describe('loadCorpus: this repository', () => {
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
