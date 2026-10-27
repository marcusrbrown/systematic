/**
 * Tests for scripts/lib/generated-surfaces.ts (U3): the ordered list of
 * generated surfaces, the downstream closure, and the git change-set logic.
 *
 * Two kinds of tests live here:
 *   - Coverage guards against the REAL repo (R16, R17, forward-order, literal
 *     paths vs the generators' exported constants). These read git state and
 *     source files but write nothing.
 *   - Behaviour tests with fakes: temp git repos built with the shared
 *     git-worktree fixtures (which strip `GIT_*`) and fake surface lists.
 *     Nothing here writes a tracked file.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { CE_REVIEW_VALIDATOR_RELATIVE_PATH } from '../../scripts/generate-ce-review-validator.js'
import { BUNDLED_NAMES_RELATIVE_PATH } from '../../scripts/generate-config-schema.js'
import {
  FINDINGS_SCHEMA_RELATIVE_PATH,
  PIPELINE_SCHEMA_RELATIVE_PATH,
  REVIEW_SCHEMA_RELATIVE_PATH,
} from '../../scripts/generate-review-artifact-schema.js'
import {
  checkPreflight,
  deriveClosureEdges,
  expandOutputs,
  findBackwardEdges,
  findDeadPaths,
  formatAffectedSurface,
  formatDriftSummary,
  formatNothingToRegenerate,
  formatPreflightFailure,
  formatRegenFailure,
  formatSurfaceResult,
  GENERATED_SURFACES,
  type GeneratedSurface,
  isChangeSetError,
  listRepoFiles,
  literalPrefix,
  matchesGlob,
  resolveChangeSet,
  resolveScriptFile,
  selectAffected,
} from '../../scripts/lib/generated-surfaces.js'
import {
  cleanupTempDirs,
  commitFiles,
  createRepo,
  git,
  makeDir,
  ROOT_DIR,
} from './git-worktree-fixtures.js'

afterEach(() => {
  cleanupTempDirs()
})

// The quoted check-mode literal, built so this file's own text is irrelevant
// (tests are not scanned by the coverage rule anyway).
const CHECK_LITERAL = `'${'--check'}'`

function fake(
  name: string,
  outputs: readonly string[],
  triggers: readonly string[],
): GeneratedSurface {
  return {
    name,
    regenScript: `${name}:generate`,
    checkScript: `${name}:drift`,
    outputs,
    triggers,
  }
}

const names = (surfaces: readonly GeneratedSurface[]) =>
  surfaces.map((s) => s.name)

// ── The real list ───────────────────────────────────────────────────────────

describe('GENERATED_SURFACES', () => {
  test('holds the seven surfaces in regeneration order', () => {
    expect(names(GENERATED_SURFACES)).toEqual([
      'agent-browser',
      'schema',
      'config-reference',
      'review-schemas',
      'validator',
      'registry',
      'pi-personas',
    ])
  })

  test('declares commands as package-script names that exist', () => {
    const scripts = JSON.parse(
      fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'),
    ).scripts as Record<string, string>
    for (const s of GENERATED_SURFACES) {
      expect(scripts[s.regenScript]).toBeDefined()
      expect(scripts[s.checkScript]).toBeDefined()
    }
    expect(scripts['registry:generate']).toBe(
      'bun scripts/generate-registry.ts',
    )
    // registry:build belongs to the OCX builder and must stay that way.
    expect(scripts['registry:build']).toBe('bun scripts/build-registry.ts')
  })

  test('uses brace-free paths; only two outputs keep a glob', () => {
    for (const s of GENERATED_SURFACES) {
      for (const p of [...s.outputs, ...s.triggers]) {
        expect(p).not.toMatch(/[{}]/)
      }
    }
    const globbedOutputs = GENERATED_SURFACES.flatMap((s) =>
      s.outputs.filter((o) => o.includes('*')),
    )
    expect(globbedOutputs.sort()).toEqual([
      'docs/public/schemas/v*/systematic-config.schema.json',
      'tests/fixtures/pi-subagents-personas/**',
    ])
  })

  test('literal outputs equal the generators exported path constants', () => {
    const outputsOf = (name: string) =>
      GENERATED_SURFACES.find((s) => s.name === name)?.outputs ?? []
    expect([...outputsOf('review-schemas')].sort()).toEqual(
      [
        REVIEW_SCHEMA_RELATIVE_PATH,
        FINDINGS_SCHEMA_RELATIVE_PATH,
        PIPELINE_SCHEMA_RELATIVE_PATH,
      ].sort(),
    )
    expect(outputsOf('validator')).toEqual([CE_REVIEW_VALIDATOR_RELATIVE_PATH])
    expect(outputsOf('schema')).toContain(BUNDLED_NAMES_RELATIVE_PATH)
  })

  test('the lib never contains the quoted check-mode literal', () => {
    const text = fs.readFileSync(
      path.join(ROOT_DIR, 'scripts/lib/generated-surfaces.ts'),
      'utf8',
    )
    expect(text).not.toContain(CHECK_LITERAL)
  })
})

// ── R16: no dead globs, against tracked plus untracked files ───────────────

describe('R16 coverage against the real repo', () => {
  const files = listRepoFiles(ROOT_DIR)

  test('lists tracked files', () => {
    expect(files).toContain('package.json')
    expect(files.length).toBeGreaterThan(100)
  })

  test('every trigger glob, individually, matches at least one file', () => {
    const dead: string[] = []
    for (const s of GENERATED_SURFACES) {
      for (const glob of s.triggers) {
        if (!files.some((f) => matchesGlob(glob, f))) {
          dead.push(`${s.name}: ${glob}`)
        }
      }
    }
    expect(dead).toEqual([])
  })

  test('every output entry expands to at least one file', () => {
    const dead: string[] = []
    for (const s of GENERATED_SURFACES) {
      for (const output of s.outputs) {
        if (!files.some((f) => matchesGlob(output, f))) {
          dead.push(`${s.name}: ${output}`)
        }
      }
    }
    expect(dead).toEqual([])
    expect(findDeadPaths(GENERATED_SURFACES, files)).toEqual([])
  })

  test('a fake dead trigger and a fake dead output are each reported', () => {
    const surfaces = [
      fake('live', ['out/a.txt'], ['src/a.ts']),
      fake('dead-trigger', ['out/a.txt'], ['src/nope-*.ts']),
      fake('dead-output', ['out/missing.txt'], ['src/a.ts']),
    ]
    const dead = findDeadPaths(surfaces, ['src/a.ts', 'out/a.txt'])
    expect(dead).toEqual([
      { surface: 'dead-trigger', kind: 'trigger', pattern: 'src/nope-*.ts' },
      { surface: 'dead-output', kind: 'output', pattern: 'out/missing.txt' },
    ])
  })

  test('the glob-valued outputs expand to the real files', () => {
    const pi = GENERATED_SURFACES.find((s) => s.name === 'pi-personas')
    const schema = GENERATED_SURFACES.find((s) => s.name === 'schema')
    expect(pi).toBeDefined()
    expect(schema).toBeDefined()
    if (pi === undefined || schema === undefined) {
      return
    }
    expect(expandOutputs(pi, files).length).toBeGreaterThan(5)
    expect(
      expandOutputs(schema, files).some((f) =>
        /^docs\/public\/schemas\/v\d+\/systematic-config\.schema\.json$/.test(
          f,
        ),
      ),
    ).toBe(true)
  })
})

// ── R17: generators with a check mode all have an entry (bidirectional) ────

function findCheckModeFiles(rootDir: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') {
          continue
        }
        walk(full)
      } else if (
        /\.(ts|mts|js|mjs)$/.test(entry.name) &&
        !/\.(test|spec)\./.test(entry.name) &&
        fs.readFileSync(full, 'utf8').includes(CHECK_LITERAL)
      ) {
        found.push(path.relative(rootDir, full))
      }
    }
  }
  for (const base of ['scripts', 'docs/scripts']) {
    const dir = path.join(rootDir, base)
    if (fs.existsSync(dir)) {
      walk(dir)
    }
  }
  return found.sort()
}

function r17Diff(rootDir: string, surfaces: readonly GeneratedSurface[]) {
  const withLiteral = findCheckModeFiles(rootDir)
  const targets = surfaces.map((s) => ({
    surface: s.name,
    file: resolveScriptFile(rootDir, s.checkScript),
  }))
  const targetFiles = targets.flatMap((t) =>
    t.file === undefined ? [] : [t.file],
  )
  return {
    withLiteral,
    unregistered: withLiteral.filter((f) => !targetFiles.includes(f)),
    noLiteral: targets
      .filter((t) => t.file === undefined || !withLiteral.includes(t.file))
      .map((t) => t.surface),
  }
}

describe('R17 generators with a check mode', () => {
  test('the real repo: both directions agree, and there are seven', () => {
    const diff = r17Diff(ROOT_DIR, GENERATED_SURFACES)
    expect(diff.unregistered).toEqual([])
    expect(diff.noLiteral).toEqual([])
    expect(diff.withLiteral).toHaveLength(7)
  })

  function tempProject(files: Record<string, string>, scripts: object) {
    const dir = makeDir('surfaces-r17-')
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts }),
    )
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), content)
    }
    return dir
  }

  test('a file with the literal and no entry fails the first direction', () => {
    const dir = tempProject(
      {
        'scripts/a.ts': `if (x === ${CHECK_LITERAL}) {}\n`,
        'scripts/b.ts': `if (x === ${CHECK_LITERAL}) {}\n`,
      },
      { 'a:drift': 'bun scripts/a.ts --check' },
    )
    const diff = r17Diff(dir, [fake('a', [], [])].map(withCheck('a:drift')))
    expect(diff.unregistered).toEqual(['scripts/b.ts'])
    expect(diff.noLiteral).toEqual([])
  })

  test('an entry whose target lacks the literal fails the second direction', () => {
    const dir = tempProject(
      {
        'scripts/a.ts': `if (x === ${CHECK_LITERAL}) {}\n`,
        'scripts/b.ts': 'export {}\n',
      },
      { 'a:drift': 'bun scripts/a.ts', 'b:drift': 'bun scripts/b.ts' },
    )
    const diff = r17Diff(dir, [
      withCheck('a:drift')(fake('a', [], [])),
      withCheck('b:drift')(fake('b', [], [])),
    ])
    expect(diff.noLiteral).toEqual(['b'])
    expect(diff.unregistered).toEqual([])
  })

  test('test files and nested docs/scripts are handled', () => {
    const dir = tempProject(
      {
        'docs/scripts/g.ts': `x(${CHECK_LITERAL})\n`,
        'scripts/g.test.ts': `x(${CHECK_LITERAL})\n`,
      },
      { 'g:drift': 'bun docs/scripts/g.ts --check' },
    )
    const diff = r17Diff(dir, [withCheck('g:drift')(fake('g', [], []))])
    expect(diff.withLiteral).toEqual(['docs/scripts/g.ts'])
    expect(diff.unregistered).toEqual([])
    expect(diff.noLiteral).toEqual([])
  })

  test('resolveScriptFile returns undefined for unknown or non-file scripts', () => {
    const dir = tempProject({}, { 'x:run': 'tsc --noEmit' })
    expect(resolveScriptFile(dir, 'x:run')).toBeUndefined()
    expect(resolveScriptFile(dir, 'missing')).toBeUndefined()
  })
})

function withCheck(checkScript: string) {
  return (s: GeneratedSurface): GeneratedSurface => ({ ...s, checkScript })
}

// ── Closure ─────────────────────────────────────────────────────────────────

describe('closure edges', () => {
  test('the real list derives only forward edges (reported verbatim)', () => {
    const edges = deriveClosureEdges(
      GENERATED_SURFACES,
      listRepoFiles(ROOT_DIR),
    )
    expect(findBackwardEdges(GENERATED_SURFACES, edges)).toEqual([])
    const asText = edges.map((e) => `${e.from}->${e.to}`).sort()
    // Not a pin: the rule derives the edges. These must be among them, which
    // also proves file matching is not vacuous.
    for (const expected of [
      'agent-browser->schema',
      'agent-browser->registry',
      'schema->config-reference',
      'review-schemas->registry',
      'validator->registry',
    ]) {
      expect(asText).toContain(expected)
    }
  })

  test('an expanded output path is matched against a trigger glob', () => {
    const a = fake('a', ['gen/out.txt'], ['src/**'])
    const b = fake('b', ['b/out.txt'], ['gen/*.txt'])
    const edges = deriveClosureEdges([a, b], ['gen/out.txt', 'src/x.ts'])
    expect(edges).toEqual([{ from: 'a', to: 'b' }])
  })

  test('a glob output links to a literal trigger through a real path', () => {
    const a = fake('a', ['gen/*.json'], ['src/**'])
    const b = fake('b', ['b.txt'], ['gen/one.json'])
    expect(
      deriveClosureEdges([a, b], ['gen/one.json', 'gen/two.json']),
    ).toEqual([{ from: 'a', to: 'b' }])
  })

  test('patterns that never share a real path are not linked', () => {
    const a = fake('a', ['gen/*.json'], ['src/**'])
    const b = fake('b', ['b.txt'], ['gen/**/*.md'])
    // Both patterns "overlap" textually under gen/, but no real file is both.
    expect(
      deriveClosureEdges([a, b], ['gen/one.json', 'gen/docs/readme.md']),
    ).toEqual([])
  })

  test('self-edges are ignored', () => {
    const a = fake('a', ['ATTRIBUTIONS.md'], ['ATTRIBUTIONS.md'])
    expect(deriveClosureEdges([a], ['ATTRIBUTIONS.md'])).toEqual([])
    const picked = selectAffected([a], ['ATTRIBUTIONS.md'], ['ATTRIBUTIONS.md'])
    expect(names(picked.direct)).toEqual(['a'])
    expect(picked.downstream).toEqual([])
  })

  test('downstream follows transitive chains, in list order', () => {
    const a = fake('a', ['a.out'], ['a.in'])
    const b = fake('b', ['b.out'], ['a.out'])
    const c = fake('c', ['c.out'], ['b.out'])
    const d = fake('d', ['d.out'], ['unrelated'])
    const files = ['a.in', 'a.out', 'b.out', 'c.out', 'd.out', 'unrelated']
    const picked = selectAffected([a, b, c, d], ['a.in'], files)
    expect(names(picked.direct)).toEqual(['a'])
    expect(names(picked.downstream)).toEqual(['b', 'c'])
  })

  test('a surface that is both a direct match and downstream is direct only', () => {
    const a = fake('a', ['a.out'], ['a.in'])
    const b = fake('b', ['b.out'], ['a.out', 'b.in'])
    const files = ['a.in', 'a.out', 'b.in', 'b.out']
    const picked = selectAffected([a, b], ['a.in', 'b.in'], files)
    expect(names(picked.direct)).toEqual(['a', 'b'])
    expect(picked.downstream).toEqual([])
  })

  test('nothing matched selects nothing', () => {
    const picked = selectAffected(
      GENERATED_SURFACES,
      ['README.md'],
      [...listRepoFiles(ROOT_DIR)],
    )
    expect(picked.direct).toEqual([])
    expect(picked.downstream).toEqual([])
  })

  test('a misordered fake list is reported, so the check is not vacuous', () => {
    const upstream = fake('upstream', ['gen/out.txt'], ['src/a.ts'])
    const downstream = fake('downstream', ['d.out'], ['gen/out.txt'])
    const files = ['src/a.ts', 'gen/out.txt', 'd.out']
    const good = [upstream, downstream]
    const bad = [downstream, upstream]
    expect(findBackwardEdges(good, deriveClosureEdges(good, files))).toEqual([])
    expect(findBackwardEdges(bad, deriveClosureEdges(bad, files))).toEqual([
      { from: 'upstream', to: 'downstream' },
    ])
  })
})

describe('globs and prefixes', () => {
  test('literalPrefix is the text before the first star', () => {
    expect(
      literalPrefix('docs/public/schemas/v*/systematic-config.schema.json'),
    ).toBe('docs/public/schemas/v')
    expect(literalPrefix('tests/fixtures/pi-subagents-personas/**')).toBe(
      'tests/fixtures/pi-subagents-personas/',
    )
    expect(literalPrefix('registry/registry.jsonc')).toBe(
      'registry/registry.jsonc',
    )
    expect(literalPrefix('*.md')).toBe('')
  })

  test('matchesGlob matches dotfile directories and spaces', () => {
    expect(matchesGlob('.github/**', '.github/workflows/main.yaml')).toBe(true)
    expect(matchesGlob('skills/**', 'skills/new skill/SKILL.md')).toBe(true)
    expect(matchesGlob('agents/**/*.md', 'agents/review/x.md')).toBe(true)
    expect(matchesGlob('agents/**/*.md', 'skills/x.md')).toBe(false)
  })

  test('expandOutputs matches globs and literals against the file list', () => {
    const s = fake('s', ['gen/v*/schema.json', 'lit.txt', 'gone.txt'], [])
    expect(
      expandOutputs(s, ['gen/v3/schema.json', 'gen/v4/schema.json', 'lit.txt']),
    ).toEqual(['gen/v3/schema.json', 'gen/v4/schema.json', 'lit.txt'])
  })
})

// ── Change set (temp git repos) ─────────────────────────────────────────────

function write(work: string, rel: string, content: string) {
  const file = path.join(work, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

describe('resolveChangeSet', () => {
  test('an unchanged tree is an empty set, not an error', () => {
    const repo = createRepo()
    expect(resolveChangeSet(repo.work)).toEqual([])
  })

  test('staged, unstaged and untracked changes are all included', () => {
    const repo = createRepo({
      files: { 'a.txt': 'a\n', 'b.txt': 'b\n' },
    })
    write(repo.work, 'a.txt', 'changed\n')
    git(repo.work, ['add', 'a.txt'])
    write(repo.work, 'b.txt', 'changed\n')
    write(repo.work, 'new/untracked.txt', 'u\n')
    write(repo.work, 'staged-new.txt', 's\n')
    git(repo.work, ['add', 'staged-new.txt'])
    expect(resolveChangeSet(repo.work)).toEqual([
      'a.txt',
      'b.txt',
      'new/untracked.txt',
      'staged-new.txt',
    ])
  })

  test('commits ahead of origin/main count too', () => {
    const repo = createRepo()
    git(repo.work, ['checkout', '-q', '-b', 'feature'])
    commitFiles(repo.work, { 'feature.txt': 'f\n' }, 'feature')
    expect(resolveChangeSet(repo.work)).toEqual(['feature.txt'])
  })

  test('a deleted tracked file is in the set (no existence filter)', () => {
    const repo = createRepo({ files: { 'gone.txt': 'x\n' } })
    fs.rmSync(path.join(repo.work, 'gone.txt'))
    expect(resolveChangeSet(repo.work)).toEqual(['gone.txt'])
  })

  test('a rename shows both the old and the new path', () => {
    const repo = createRepo({ files: { 'old.txt': 'x\n' } })
    git(repo.work, ['mv', 'old.txt', 'new.txt'])
    expect(resolveChangeSet(repo.work)).toEqual(['new.txt', 'old.txt'])
  })

  test('paths with spaces and non-ASCII characters survive NUL parsing', () => {
    const repo = createRepo({ files: { 'agents/é tracked.md': 'x\n' } })
    write(repo.work, 'agents/é tracked.md', 'changed\n')
    write(repo.work, 'skills/new skill/SKILL.md', 'u\n')
    write(repo.work, 'skills/日本/SKILL.md', 'u\n')
    expect(resolveChangeSet(repo.work)).toEqual([
      'agents/é tracked.md',
      'skills/new skill/SKILL.md',
      'skills/日本/SKILL.md',
    ])
  })

  test('ignored files are not part of the set', () => {
    const repo = createRepo({ files: { '.gitignore': 'ignored.txt\n' } })
    write(repo.work, 'ignored.txt', 'x\n')
    expect(resolveChangeSet(repo.work)).toEqual([])
  })

  test('from a subdirectory it still returns repo-root-relative paths', () => {
    const repo = createRepo({ files: { 'sub/keep.txt': 'k\n' } })
    write(repo.work, 'top-level.txt', 't\n')
    write(repo.work, 'sub/inner.txt', 'i\n')
    expect(resolveChangeSet(path.join(repo.work, 'sub'))).toEqual([
      'sub/inner.txt',
      'top-level.txt',
    ])
  })

  test('ambient GIT_* variables do not redirect it', () => {
    const decoy = createRepo()
    const repo = createRepo()
    write(repo.work, 'wanted.txt', 'w\n')
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    }
    process.env.GIT_DIR = path.join(decoy.work, '.git')
    process.env.GIT_WORK_TREE = decoy.work
    try {
      expect(resolveChangeSet(repo.work)).toEqual(['wanted.txt'])
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  test('it writes nothing: status is identical before and after', () => {
    const repo = createRepo({ files: { 'a.txt': 'a\n' } })
    write(repo.work, 'a.txt', 'changed\n')
    write(repo.work, 'u.txt', 'u\n')
    const before = git(repo.work, ['status', '--porcelain'])
    resolveChangeSet(repo.work)
    expect(git(repo.work, ['status', '--porcelain'])).toBe(before)
  })

  test('missing origin/main throws an error that names it', () => {
    const repo = createRepo()
    git(repo.work, ['update-ref', '-d', 'refs/remotes/origin/main'])
    let caught: unknown
    try {
      resolveChangeSet(repo.work)
    } catch (error) {
      caught = error
    }
    if (!isChangeSetError(caught)) {
      throw new Error('expected a change-set error')
    }
    const error = caught
    expect(error.ref).toBe('origin/main')
    expect(error.message).toContain('origin/main')
    expect(error.shallow).toBe(false)
    expect(error.message).not.toContain('unshallow')
    // Schema and config-reference resolve their version from tags.
    expect(error.message).toContain('git fetch origin main')
    expect(error.message).toContain('git fetch --tags')
  })

  test('missing merge-base throws an error naming the ref', () => {
    const repo = createRepo()
    // An unrelated history: origin/main exists, HEAD shares no ancestor.
    git(repo.work, ['checkout', '-q', '--orphan', 'unrelated'])
    commitFiles(repo.work, { 'island.txt': 'i\n' }, 'island')
    let caught: unknown
    try {
      resolveChangeSet(repo.work)
    } catch (error) {
      caught = error
    }
    if (!isChangeSetError(caught)) {
      throw new Error('expected a change-set error')
    }
    const error = caught
    expect(error.message).toContain('merge-base')
    expect(error.message).toContain('origin/main')
    expect(error.shallow).toBe(false)
  })

  test('a shallow clone adds the unshallow hint', () => {
    const source = createRepo()
    git(source.work, ['checkout', '-q', '-b', 'feature'])
    commitFiles(source.work, { 'f.txt': 'f\n' }, 'feature')
    git(source.work, ['push', '-q', 'origin', 'feature'])
    const clone = path.join(makeDir(), 'clone')
    git(source.root, [
      'clone',
      '-q',
      '--depth',
      '1',
      '--branch',
      'feature',
      `file://${source.origin}`,
      clone,
    ])
    git(clone, [
      'fetch',
      '-q',
      '--depth',
      '1',
      'origin',
      'main:refs/remotes/origin/main',
    ])
    expect(git(clone, ['rev-parse', '--is-shallow-repository'])).toBe('true')
    let caught: unknown
    try {
      resolveChangeSet(clone)
    } catch (error) {
      caught = error
    }
    if (!isChangeSetError(caught)) {
      throw new Error('expected a change-set error')
    }
    const error = caught
    expect(error.shallow).toBe(true)
    expect(error.message).toContain('merge-base')
    expect(error.message).toContain('--unshallow')
  })

  test('a missing origin/main in a shallow clone also carries the hint', () => {
    const source = createRepo()
    const clone = path.join(makeDir(), 'clone')
    git(source.root, [
      'clone',
      '-q',
      '--depth',
      '1',
      `file://${source.origin}`,
      clone,
    ])
    git(clone, ['update-ref', '-d', 'refs/remotes/origin/main'])
    let caught: unknown
    try {
      resolveChangeSet(clone)
    } catch (error) {
      caught = error
    }
    if (!isChangeSetError(caught)) {
      throw new Error('expected a change-set error')
    }
    const error = caught
    expect(error.ref).toBe('origin/main')
    expect(error.message).toContain('--unshallow')
  })

  test('isChangeSetError accepts only the typed error from resolveChangeSet', () => {
    expect(isChangeSetError(new Error('plain'))).toBe(false)
    expect(isChangeSetError(null)).toBe(false)
    expect(isChangeSetError('missing-ref')).toBe(false)
    expect(
      isChangeSetError(
        Object.assign(new Error('x'), {
          kind: 'other',
          ref: 'r',
          shallow: false,
        }),
      ),
    ).toBe(false)
    expect(
      isChangeSetError(
        Object.assign(new Error('x'), {
          kind: 'missing-ref',
          ref: 'origin/main',
          shallow: false,
        }),
      ),
    ).toBe(true)
  })

  test('outside a git repository it throws, not an empty set', () => {
    const dir = makeDir('surfaces-nogit-')
    expect(() => resolveChangeSet(dir)).toThrow()
  })
})

// ── git launch failures keep their real cause ───────────────────────────────

describe('git launch failures', () => {
  const REAL_GIT = Bun.which('git')

  /** Runs `body` with PATH replaced, restoring it afterwards. */
  function withPath<T>(value: string, body: () => T): T {
    const saved = process.env.PATH
    process.env.PATH = value
    try {
      return body()
    } finally {
      if (saved === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = saved
      }
    }
  }

  /**
   * A `git` that flooded stdout past `maxBuffer` for the commands matching
   * `floodWhen` (a `sh` condition on "$@") and delegates the rest to the real
   * git. spawnSync reports that as `error` (ENOBUFS), not as an exit status.
   */
  function fakeGitDir(floodWhen: string): string {
    if (REAL_GIT === null) {
      throw new Error('git is not on PATH')
    }
    const dir = makeDir('surfaces-fakegit-')
    const script = path.join(dir, 'git')
    fs.writeFileSync(
      script,
      [
        '#!/bin/sh',
        `if ${floodWhen}; then head -c 70000000 /dev/zero; exit 0; fi`,
        `exec ${JSON.stringify(REAL_GIT)} "$@"`,
        '',
      ].join('\n'),
    )
    fs.chmodSync(script, 0o755)
    return dir
  }

  test('git missing from PATH says git could not run, not "not a git repository"', () => {
    const repo = createRepo()
    const empty = makeDir('surfaces-nopath-')
    for (const call of [
      () => resolveChangeSet(repo.work),
      () => listRepoFiles(repo.work),
    ]) {
      let message = ''
      try {
        withPath(empty, call)
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toContain('could not run')
      expect(message).toMatch(/not found|ENOENT/i)
      expect(message).not.toContain('not inside a git repository')
    }
  })

  test('a diff that overflows the buffer names the spawn error, not an empty failure', () => {
    const repo = createRepo()
    const bin = fakeGitDir('[ "$1" = diff ]')
    let message = ''
    try {
      withPath(`${bin}:/usr/bin:/bin`, () => resolveChangeSet(repo.work))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('git diff')
    expect(message).toMatch(/ENOBUFS|maxBuffer/i)
  })

  test('a launch failure while resolving origin/main does not give fetch advice', () => {
    const repo = createRepo()
    const bin = fakeGitDir('[ "$1" = rev-parse ] && [ "$2" = --verify ]')
    let caught: unknown
    try {
      withPath(`${bin}:/usr/bin:/bin`, () => resolveChangeSet(repo.work))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(isChangeSetError(caught)).toBe(false)
    const message = (caught as Error).message
    expect(message).toContain('could not run')
    expect(message).toMatch(/ENOBUFS|maxBuffer/i)
    expect(message).not.toContain('git fetch')
  })

  test('a launch failure while finding the merge-base does not give fetch advice', () => {
    const repo = createRepo()
    const bin = fakeGitDir('[ "$1" = merge-base ]')
    let caught: unknown
    try {
      withPath(`${bin}:/usr/bin:/bin`, () => resolveChangeSet(repo.work))
    } catch (error) {
      caught = error
    }
    expect(isChangeSetError(caught)).toBe(false)
    const message = (caught as Error).message
    expect(message).toContain('could not run')
    expect(message).not.toContain('unshallow')
  })
})

// ── Matching against the real surface list in temp repos (AE2, AE3, AE5) ───

function seedFor(
  surfaces: readonly GeneratedSurface[],
): Record<string, string> {
  const seed: Record<string, string> = {}
  for (const s of surfaces) {
    for (const output of s.outputs) {
      const concrete = output.replace(/\*\*/g, 'a/b').replace(/\*/g, '3')
      seed[concrete] = 'x\n'
    }
  }
  return seed
}

describe('affected selection in a temp repo', () => {
  function seededRepo() {
    return createRepo({
      files: {
        ...seedFor(GENERATED_SURFACES),
        'agents/review/x.md': 'agent\n',
        'skills/existing/SKILL.md': 'skill\n',
        'package.json': '{}\n',
      },
    })
  }

  function select(work: string) {
    return selectAffected(
      GENERATED_SURFACES,
      resolveChangeSet(work),
      listRepoFiles(work),
    )
  }

  test('AE2: an uncommitted agent edit matches registry, Pi, schema and adds the field reference', () => {
    const repo = seededRepo()
    write(repo.work, 'agents/review/x.md', 'edited\n')
    const before = git(repo.work, ['status', '--porcelain'])
    const picked = select(repo.work)
    expect(names(picked.direct)).toEqual(['schema', 'registry', 'pi-personas'])
    expect(names(picked.downstream)).toEqual(['config-reference'])
    // Nothing was written by selecting.
    expect(git(repo.work, ['status', '--porcelain'])).toBe(before)
  })

  test('AE3: an untracked skill directory matches the registry and schema surfaces', () => {
    const repo = seededRepo()
    write(repo.work, 'skills/new-skill/SKILL.md', 'new\n')
    const picked = select(repo.work)
    expect(names(picked.direct)).toEqual(['schema', 'registry'])
    expect(names(picked.downstream)).toEqual(['config-reference'])
  })

  test('a hand edit to a generated output selects the surface that writes it', () => {
    const repo = seededRepo()
    write(
      repo.work,
      'docs/src/content/docs/reference/configuration.mdx',
      'edited by hand\n',
    )
    const picked = select(repo.work)
    expect(names(picked.direct)).toContain('config-reference')
    expect(names(picked.downstream)).not.toContain('config-reference')
  })

  test('deleting a generated output selects the surface directly', () => {
    const repo = seededRepo()
    fs.rmSync(path.join(repo.work, 'skills/agent-browser/SKILL.md'))
    const picked = select(repo.work)
    expect(names(picked.direct)).toContain('agent-browser')
    expect(names(picked.downstream)).not.toContain('agent-browser')
  })

  test('an output glob match selects the surface, as a trigger match does', () => {
    const surfaces = [fake('x', ['gen/*.txt'], ['src/x.ts'])]
    const picked = selectAffected(
      surfaces,
      ['gen/one.txt'],
      ['gen/one.txt', 'src/x.ts'],
    )
    expect(names(picked.direct)).toEqual(['x'])
  })

  test('AE5: a README-only change matches nothing', () => {
    const repo = seededRepo()
    write(repo.work, 'README.md', 'edited\n')
    const picked = select(repo.work)
    expect(picked.direct).toEqual([])
    expect(picked.downstream).toEqual([])
  })

  test('editing a trigger file selects exactly what the rule predicts', () => {
    const repo = seededRepo()
    write(repo.work, 'src/lib/review-artifact-schema.ts', 'x\n')
    const picked = select(repo.work)
    // review-schemas + validator read it; both write under skills/, which the
    // registry reads.
    expect(names(picked.direct)).toEqual(['review-schemas', 'validator'])
    expect(names(picked.downstream)).toEqual(['registry'])
  })
})

// ── Preflight ───────────────────────────────────────────────────────────────

describe('checkPreflight', () => {
  function installLayout(rootDir: string, parts: readonly string[]) {
    for (const part of parts) {
      const target = path.join(rootDir, part)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, '')
    }
  }

  test('passes when biome and zod are installed', () => {
    const dir = makeDir('surfaces-pre-')
    installLayout(dir, [
      'node_modules/.bin/biome',
      'node_modules/zod/package.json',
    ])
    expect(checkPreflight(dir)).toEqual({ ok: true, missing: [] })
  })

  test('reports a missing biome', () => {
    const dir = makeDir('surfaces-pre-')
    installLayout(dir, ['node_modules/zod/package.json'])
    const result = checkPreflight(dir)
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['node_modules/.bin/biome'])
    expect(formatPreflightFailure(result.missing)).toContain('run bun install')
    expect(formatPreflightFailure(result.missing)).toContain(
      'node_modules/.bin/biome',
    )
  })

  test('reports a missing zod', () => {
    const dir = makeDir('surfaces-pre-')
    installLayout(dir, ['node_modules/.bin/biome'])
    expect(checkPreflight(dir).missing).toEqual(['node_modules/zod'])
  })

  test('reports both when there is no node_modules at all', () => {
    const dir = makeDir('surfaces-pre-')
    const result = checkPreflight(dir)
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual([
      'node_modules/.bin/biome',
      'node_modules/zod',
    ])
  })
})

// ── Formatters ──────────────────────────────────────────────────────────────

describe('report formatters', () => {
  const [first, second, third] = [
    fake('one', [], []),
    fake('two', [], []),
    fake('three', [], []),
  ]

  test('a passing surface is one line', () => {
    expect(
      formatSurfaceResult({ surface: first, passed: true, output: 'noise' }),
    ).toBe('[PASS] one')
  })

  test('a failing surface shows indented child output and a fix line', () => {
    const text = formatSurfaceResult({
      surface: first,
      passed: false,
      output: 'line a\nline b\n',
    })
    expect(text.split('\n')).toEqual([
      '[FAIL] one',
      '    line a',
      '    line b',
      '  fix: bun run one:generate',
    ])
  })

  test('a failing surface with no output still shows the fix line', () => {
    expect(
      formatSurfaceResult({ surface: first, passed: false, output: '' }).split(
        '\n',
      ),
    ).toEqual(['[FAIL] one', '  fix: bun run one:generate'])
  })

  describe('after a shrink refusal', () => {
    // The text the schema generator prints. Pinned against its source below.
    const SHRINK_OUTPUT =
      'Error: bundled-agent count shrank from 40 to 39. If this is an intentional removal, regenerate with `bun scripts/generate-config-schema.ts --allow-shrink`.\n'
    const SHRINK_FIX =
      '  fix: bun scripts/generate-config-schema.ts --allow-shrink (an agent or skill was removed; run once, then rerun)'

    test('the matched phrase is still in the schema generator', () => {
      const source = fs.readFileSync(
        path.join(ROOT_DIR, 'scripts/generate-config-schema.ts'),
        'utf8',
      )
      expect(source).toContain('bundled-agent count shrank from')
      expect(source).toContain('bundled-skill count shrank from')
    })

    test('a failing check gets the --allow-shrink fix line instead of the regen command', () => {
      const lines = formatSurfaceResult({
        surface: first,
        passed: false,
        output: SHRINK_OUTPUT,
      }).split('\n')
      expect(lines.at(-1)).toBe(SHRINK_FIX)
      expect(lines.join('\n')).not.toContain('fix: bun run one:generate')
      expect(lines.join('\n')).toContain('count shrank from 40 to 39')
    })

    test('the skill-count variant is recognised too', () => {
      const text = formatSurfaceResult({
        surface: first,
        passed: false,
        output: 'Error: bundled-skill count shrank from 90 to 89.\n',
      })
      expect(text).toContain('--allow-shrink')
    })

    test('an ordinary failure keeps the normal fix line', () => {
      const text = formatSurfaceResult({
        surface: first,
        passed: false,
        output: 'Schema drift: file is out of date\n',
      })
      expect(text.split('\n').at(-1)).toBe('  fix: bun run one:generate')
      expect(text).not.toContain('--allow-shrink')
    })

    test('a regen failure with the shrink text gets the same fix line', () => {
      const text = formatRegenFailure({
        failed: first,
        output: SHRINK_OUTPUT,
        completed: [],
        notRun: [second],
      })
      expect(text.split('\n')).toContain(SHRINK_FIX)
    })

    test('an ordinary regen failure gets no fix line', () => {
      const text = formatRegenFailure({
        failed: first,
        output: 'boom\n',
        completed: [],
        notRun: [],
      })
      expect(text).not.toContain('fix:')
    })
  })

  test('the drift summary counts failures and names them', () => {
    expect(
      formatDriftSummary([
        { surface: first, passed: true },
        { surface: second, passed: false },
        { surface: third, passed: false },
      ]),
    ).toBe('drift: 2 of 3 failed: two, three')
    expect(
      formatDriftSummary([
        { surface: first, passed: true },
        { surface: second, passed: true },
      ]),
    ).toBe('drift: all 2 surfaces passed')
  })

  test('affected lines carry the regeneration command; downstream is marked', () => {
    expect(formatAffectedSurface(first, false).split('\n')).toEqual([
      '[AFFECTED] one',
      '  fix: bun run one:generate',
    ])
    expect(formatAffectedSurface(second, true).split('\n')).toEqual([
      '[AFFECTED] two (downstream)',
      '  fix: bun run two:generate',
    ])
  })

  test('nothing matched has its own message', () => {
    expect(formatNothingToRegenerate()).toContain('nothing to regenerate')
  })

  test('a regen failure names the failed surface, the not-run ones and the partial state', () => {
    const text = formatRegenFailure({
      failed: second,
      output: 'boom\n',
      completed: [first],
      notRun: [third],
    })
    expect(text).toContain('two')
    expect(text).toContain('boom')
    expect(text).toContain('three')
    expect(text).toContain('one')
    expect(text).toContain('already rewritten')
    expect(text).toContain('partly regenerated')
  })

  test('a first-surface regen failure does not claim anything was rewritten', () => {
    const text = formatRegenFailure({
      failed: first,
      output: '',
      completed: [],
      notRun: [second],
    })
    expect(text).not.toContain('already rewritten')
    expect(text).toContain('two')
  })
})
